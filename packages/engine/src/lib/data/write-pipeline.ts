/**
 * Write pipeline for the CRUD data path (H-05 split of `routes/data.ts`).
 *
 * Everything on the write side EXCEPT the per-handler pre/post hook calls
 * (which are tightly interleaved with the route flow and stay inline):
 *
 *  - `processInput`   — validate + deserialize + encrypt incoming field values
 *  - `mapPgError` / `handlePgErrors` — translate Postgres SQLSTATEs into 4xx
 *  - `afterWrite`     — revision log + webhook + realtime + cache + flows + events
 *  - `broadcastWebhook`, `getVirtualConfig`, `getDb`, `runAtomic`, `isUuid`
 *
 * Every branch, string, SQLSTATE mapping and side-effect ordering is
 * byte-identical to the pre-split inline helpers — zero behaviour change.
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Database } from '../../db/index.js';
import { DDLManager } from './ddl-manager.js';
import { fieldTypeRegistry } from './field-type-registry.js';
import { maybeEncrypt } from './field-crypto.js';
import { WebhookManager } from '../webhooks.js';
import { broadcastEvent } from '../../routes/ws.js';
import { realtimeBus } from '../runtime/index.js';
import { broadcastDataEvent } from '../../routes/realtime.js';
import { engineEvents } from '../runtime/index.js';
import { triggerDataFlows } from '../../routes/flows.js';
import { invalidateQueryCache } from './query-cache.js';
import { normalizeFields } from './shape.js';
import type { CollectionDef } from './types.js';
import type { DynamicDB } from '../../db/dynamic-types.js';
import type { VirtualConfig } from '../virtual-collection-adapter.js';

/** Returns the tenant-isolated transaction DB when in multi-tenant mode, else
 * the pool. */
export function getDb(c: Context, fallback: Database): Database {
  return c.get('tenantTrx') ?? fallback;
}

/** The current request's tenant id (null in single-tenant mode). */
export function getTenantId(c: Context): string | null {
  return c.get('tenant')?.id ?? null;
}

/** Type-erased view of a Database for querying a dynamic (user-created) table
 * whose columns are only known at runtime. Kysely's schema-typed builder can't
 * express `selectFrom(runtimeTableName)`, so callers go through this single
 * documented escape hatch (`DynamicDB` is the one tracked survivor) instead of
 * scattering `as any` across every handler. */
export function dynamicDb(db: Database): DynamicDB {
  return db as unknown as DynamicDB;
}

/**
 * Run `fn` atomically. When `executor` is already a transaction (the per-request
 * tenant transaction, always present on /api/data routes), reuse it — Bun SQL
 * has no nested transactions, so calling `.transaction()` on it would error.
 * Otherwise open a fresh transaction on the pool.
 */
export function runAtomic<T>(executor: Database, fn: (trx: Database) => Promise<T>): Promise<T> {
  if ((executor as unknown as { isTransaction?: boolean }).isTransaction) {
    return fn(executor);
  }
  return executor.transaction().execute(fn);
}

// RFC 4122 UUID (any version). Short-circuiting here turns an otherwise
// user-visible Postgres "invalid input syntax for uuid" 500 into a clean 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/** Returns the parsed VirtualConfig if the collection has source_type='virtual',
 * else null. */
export async function getVirtualConfig(
  db: Database,
  collection: string,
): Promise<VirtualConfig | null> {
  const meta = (await DDLManager.getCollection(db, collection)) as CollectionDef | null;
  if (meta?.source_type !== 'virtual' || !meta?.virtual_config) return null;
  return typeof meta.virtual_config === 'string'
    ? (JSON.parse(meta.virtual_config) as VirtualConfig)
    : (meta.virtual_config as VirtualConfig);
}

/** Validate and deserialize incoming data using the field-type registry. */
export async function processInput(
  data: Record<string, unknown>,
  collectionDef: CollectionDef | null | undefined,
  partial = false,
): Promise<{ errors: string[]; processed: Record<string, unknown> }> {
  const errors: string[] = [];
  const processed: Record<string, unknown> = {};

  const fields = normalizeFields(collectionDef);
  if (fields.length === 0) return { errors, processed: data };

  for (const field of fields) {
    const typeDef = fieldTypeRegistry.get(field.type);
    if (!typeDef || typeDef.db.virtual) continue;

    const value = data[field.name];

    // In partial mode (PATCH), only touch fields the caller actually sent.
    // Skipping validate here preserves required-field enforcement on create/replace.
    if (partial && value === undefined) continue;

    const error = fieldTypeRegistry.validate(field.type, value, field);
    if (error) errors.push(error);

    if (value !== undefined) {
      const deserialized = fieldTypeRegistry.deserialize(field.type, value);
      processed[field.name] = field.encrypted
        ? await maybeEncrypt(deserialized, true)
        : deserialized;
    }
  }

  return { errors, processed };
}

/** Broadcast webhook event. */
async function broadcastWebhook(
  _db: Database,
  event: string,
  collection: string,
  data: Record<string, unknown> & { id: string },
): Promise<void> {
  // WebhookManager.trigger() handles:
  // - matching active webhooks by event + collection
  // - queuing via Redis (webhook:queue)
  // - audit trail in zvd_webhook_deliveries
  // - retry logic via webhook:retry sorted set
  await WebhookManager.trigger(event, collection, data);
}

/** Map Postgres SQLSTATE codes to HTTP responses with structured error bodies.
 * Without this, every constraint violation hits Hono's default error handler
 * and surfaces as 500 "Internal Server Error" plain text.
 *
 * Bun.SQL PostgresError exposes the Postgres notice fields but the property
 * names vary slightly across versions (`code` / `errno` / `routine`) — we read
 * the standard fields and fall back to message-pattern matching as a safety
 * net for cases where the SQLSTATE is missing. */
export function mapPgError(
  err: unknown,
): { status: ContentfulStatusCode; body: Record<string, unknown> } | null {
  if (!err) return null;
  const e = err as Record<string, unknown>;
  const code = String((e.code as string | undefined) ?? (e.errno as string | undefined) ?? '');
  const message = String((e.message as string | undefined) ?? '');
  const detail = String((e.detail as string | undefined) ?? '');
  const constraint = String(
    (e.constraint_name as string | undefined) ?? (e.constraint as string | undefined) ?? '',
  );
  const column = String(
    (e.column_name as string | undefined) ?? (e.column as string | undefined) ?? '',
  );

  const matchKey = /Key \(([^)]+)\)=\(([^)]+)\)(?: is not present in table "([^"]+)")?/.exec(
    detail || message,
  );

  // 42501 — insufficient_privilege: in practice, row-level security rejected
  // the statement (e.g. a write whose tenant context doesn't match the row's
  // tenant). Surfacing the raw 500 hid the real cause of the "insert fails on
  // an RLS-enabled instance" class; a clean 403 names it.
  if (code === '42501' || /row-level security/i.test(message)) {
    return {
      status: 403,
      body: {
        error: 'row_level_security_violation',
        message:
          "The operation violates the collection's row-level security policy for the current tenant context.",
        code: code || '42501',
      },
    };
  }
  // 23503 — foreign_key_violation
  if (code === '23503' || /foreign key constraint/i.test(message)) {
    return {
      status: 422,
      body: {
        error: 'foreign_key_violation',
        message: matchKey
          ? `Field "${matchKey[1]}" references "${(matchKey[3] ?? '').replace(/^zvd_/, '') || 'another collection'}" but no record with id "${matchKey[2]}" exists.`
          : 'Referenced record does not exist.',
        code: code || '23503',
        field: matchKey?.[1] ?? column ?? null,
      },
    };
  }
  // 23505 — unique_violation
  if (
    code === '23505' ||
    /duplicate key value/i.test(message) ||
    /unique constraint/i.test(message)
  ) {
    return {
      status: 409,
      body: {
        error: 'unique_violation',
        message: matchKey
          ? `A record with the same ${matchKey[1]} already exists (value: ${matchKey[2]}).`
          : 'A record with the same unique value already exists.',
        code: code || '23505',
        field: matchKey?.[1] ?? null,
      },
    };
  }
  // 23502 — not_null_violation
  if (
    code === '23502' ||
    /not-null constraint/i.test(message) ||
    /violates not-null/i.test(message)
  ) {
    return {
      status: 422,
      body: {
        error: 'not_null_violation',
        message: column ? `Field "${column}" is required.` : 'A required field is missing.',
        code: code || '23502',
        field: column ?? null,
      },
    };
  }
  // 23514 — check_violation (status enum, etc.)
  if (code === '23514' || /check constraint/i.test(message)) {
    return {
      status: 422,
      body: {
        error: 'check_violation',
        message: 'One of the values does not satisfy the field constraints.',
        code: code || '23514',
        constraint: constraint || null,
      },
    };
  }
  // 22P02 — invalid_text_representation (e.g. bad UUID)
  if (code === '22P02' || /invalid input syntax/i.test(message)) {
    return {
      status: 422,
      body: {
        error: 'invalid_value',
        message:
          'One of the values has the wrong format (likely an invalid UUID, number, or date).',
        code: code || '22P02',
      },
    };
  }
  // 42703 — undefined_column (schema drift)
  if (code === '42703' || /column .* does not exist/i.test(message)) {
    return {
      status: 422,
      body: {
        error: 'unknown_field',
        message: 'A field in the request does not exist on this collection.',
        code: code || '42703',
      },
    };
  }
  return null;
}

/** Run an async handler and translate known Postgres errors into 4xx responses
 * before they escape as Hono's default 500. Anything we don't recognize is
 * re-thrown so the global error handler can log it. */
export async function handlePgErrors<T>(c: Context, fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (err) {
    const mapped = mapPgError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    // Surface the raw error shape so we can extend mapPgError() later.
    const e = err as { name?: string; code?: string; errno?: string; message?: string };
    console.warn(
      '[handlePgErrors] unmapped error:',
      e?.name,
      'code=',
      e?.code ?? e?.errno,
      'msg=',
      e?.message,
    );
    throw err;
  }
}

/** Post-write side-effects: revision log, webhook, realtime broadcast, embeddings, events. */
export async function afterWrite(
  db: Database,
  opts: {
    collection: string;
    recordId: string;
    action: 'create' | 'update' | 'delete';
    /** The written row (DB-shaped: values `unknown`). Only stringified +
     * forwarded to webhooks/realtime/events, never indexed field-by-field. */
    data: Record<string, unknown>;
    delta?: Record<string, unknown>;
    userId: string;
    /**
     * Tenant id from the request's `tenantTrx` context. Forwarded onto
     * `engineEvents.emit('record.*')` so subscribers (notably the
     * `ai` extension's auto-embedding hook) can tag their writes with
     * the right tenant — they run on the GLOBAL pool, NOT inside the
     * request transaction, so they cannot rely on
     * `current_setting('zveltio.current_tenant')`.
     */
    tenantId?: string | null;
  },
): Promise<void> {
  const { collection, recordId, action, data, delta, userId, tenantId } = opts;

  // Revision log — awaited so callers see a consistent DB state after the write,
  // but errors are swallowed (non-fatal).
  await db
    .insertInto('zv_revisions')
    .values({
      collection,
      record_id: recordId,
      action,
      data: JSON.stringify(data),
      ...(delta ? { delta: JSON.stringify(delta) } : {}),
      user_id: userId,
    })
    .execute()
    .catch((err) => console.error('[afterWrite] revision log failed:', err));

  const eventName = action === 'create' ? 'insert' : action === 'update' ? 'update' : 'delete';

  await broadcastWebhook(
    db,
    eventName,
    collection,
    data as Record<string, unknown> & { id: string },
  );
  // tenant id flows into WS + SSE broadcasts so a write in tenant A
  // doesn't fan out to subscribers in tenant B (collection names
  // collide across tenants on both channel namespaces).
  broadcastEvent(collection, eventName as 'insert' | 'update' | 'delete', data, tenantId ?? null);
  broadcastDataEvent(collection, eventName, data, tenantId ?? null);

  // Publish to the cross-instance realtime bus (Valkey if
  // configured, else pg_notify). The bus filters its own echo so the
  // already-fired local `broadcastEvent` above doesn't double-deliver.
  realtimeBus()
    .publish({
      event: `record.${action === 'create' ? 'created' : action === 'update' ? 'updated' : 'deleted'}`,
      collection,
      record_id: recordId as string,
      data,
      timestamp: new Date().toISOString(),
      tenantId: tenantId ?? null,
    })
    .catch((err) => console.error('[afterWrite] realtime publish failed:', err));

  // Embedding triggered via engineEvents.emit('record.created' | 'record.updated')
  // below — the `ai` extension subscribes to those events. No core call needed.

  // Invalidate query cache for this collection on every write, scoped
  // to the writing tenant — invalidating across tenants would just
  // churn other tenants' hot caches with no correctness benefit since
  // the cache key already includes the tenant id.
  // If this fails the read path serves stale data until TTL expires —
  // log so a chronic failure (Valkey down, eviction storm) is visible.
  invalidateQueryCache(collection, tenantId ?? null).catch((err) => {
    console.warn(`[data] invalidateQueryCache failed for ${collection}:`, (err as Error).message);
  });

  // Trigger data_event flows (fire-and-forget — must not block the request).
  // Scoped to the writing tenant so a write in tenant A doesn't fire tenant B's flows.
  triggerDataFlows(
    db,
    collection,
    eventName as 'insert' | 'update' | 'delete',
    data,
    tenantId ?? null,
  ).catch((err) => console.error('[afterWrite] flow trigger failed:', err));

  const engineEvent =
    action === 'create'
      ? 'record.created'
      : action === 'update'
        ? 'record.updated'
        : 'record.deleted';
  engineEvents.emit(engineEvent, {
    collection,
    record: data,
    id: recordId,
    userId,
    tenantId: tenantId ?? null,
  });
}
