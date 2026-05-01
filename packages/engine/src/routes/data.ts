import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { fieldTypeRegistry } from '../lib/field-type-registry.js';
import { checkPermission } from '../lib/permissions.js';
import { WebhookManager } from '../lib/webhooks.js';
import { broadcastEvent } from './ws.js';
import { broadcastDataEvent } from './realtime.js';
import { triggerEmbedding } from '../lib/ai-embed-hook.js';
import { engineEvents } from '../lib/event-bus.js';
import { triggerDataFlows } from './flows.js';
import {
  dynamicSelect,
  dynamicInsert,
  dynamicUpdate,
  dynamicDelete,
  type FilterCondition,
} from '../db/dynamic.js';
import { hashApiKey } from '../lib/api-key-hash.js';
import { maybeEncrypt, maybeDecrypt } from '../lib/field-crypto.js';
import { tracedQuery } from '../lib/telemetry.js';
import { getRlsFilters } from '../lib/rls.js';
import { getColumnAccess, applyColumnAccess, filterWritableFields } from '../lib/column-permissions.js';
import { buildQueryCacheKey, getQueryCache, setQueryCache, invalidateQueryCache } from '../lib/query-cache.js';

/** Minimal user shape attached to every authenticated request context */
export interface RequestUser {
  id: string;
  name: string;
  role: string;
  /** Present only for API-key auth — collection/action scopes */
  scopes?: unknown;
  /** Email — present for session auth */
  email?: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    user: RequestUser;
    authType: 'session' | 'api_key';
  }
}
import {
  virtualList,
  virtualGetOne,
  virtualCreate,
  virtualUpdate,
  virtualDelete,
  type VirtualConfig,
} from '../lib/virtual-collection-adapter.js';

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  filter: z.string().optional(),
  search: z.string().optional(),
  as_of: z.string().optional(),
  cursor: z.string().optional(), // base64url-encoded {id, val}
});

async function computeEtag(data: any[]): Promise<string> {
  const str = JSON.stringify(data);
  // SHA-256: stronger than SHA-1 and not truncated — avoids collision risk
  // (truncated SHA-1 to 64 bits had birthday-attack probability of ~2^-32).
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Authenticate request — session or API key
async function authenticate(c: any, auth: any, db: Database): Promise<{ user: any; authType: string } | null> {
  // Try session
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session) return { user: session.user, authType: 'session' };

  // Try API key
  const rawKey =
    c.req.header('X-API-Key') || c.req.header('Authorization')?.replace('Bearer ', '');

  if (rawKey?.startsWith('zvk_')) {
    const apiKey = await validateApiKey(db, rawKey);
    if (apiKey) {
      return {
        user: {
          id: `apikey:${apiKey.id}`,
          name: apiKey.name,
          role: 'api_key',
          // C3 FIX: pass scopes so checkAccess() can enforce them per collection/action
          scopes: apiKey.scopes,
        },
        authType: 'api_key',
      };
    }
  }

  return null;
}

async function validateApiKey(db: Database, rawKey: string): Promise<import('../db/schema.js').ZvApiKeyRow | null> {
  const hash = await hashApiKey(rawKey);
  const apiKey = await db
    .selectFrom('zv_api_keys')
    .selectAll()
    .where('key_hash', '=', hash)
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!apiKey) return null;
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) return null;

  // Update last_used_at — fire-and-forget; non-blocking on hot path
  db.updateTable('zv_api_keys')
    .set({ last_used_at: new Date() })
    .where('id', '=', apiKey.id)
    .execute()
    .catch((err) => console.error('[validateApiKey] last_used_at update failed:', err));

  return apiKey;
}

async function checkAccess(
  db: Database,
  user: any,
  collection: string,
  action: string,
): Promise<boolean> {
  // I5 FIX: removed `user.role === 'admin'` shortcut — Better-Auth may not populate
  // role on session in all auth flows (magic link, OAuth). checkPermission() handles
  // god bypass (DB + HMAC cache) first, then Casbin, so admin users with proper
  // Casbin policies still get access without relying on the session role field.
  if (user.role === 'api_key') {
    // API keys cannot access system tables
    const tableName = DDLManager.getTableName(collection);
    if (tableName.startsWith('zv_') && !tableName.startsWith('zvd_')) return false;

    // C3 FIX: Enforce API key scopes.
    // Scopes format: Array<{ collection: string; actions: string[] }>
    // Empty scopes array = full access (backwards-compatible default).
    // Wildcard collection '*' or action '*' grants broad access.
    const rawScopes = user.scopes;
    if (rawScopes) {
      const scopes: Array<{ collection: string; actions: string[] }> =
        typeof rawScopes === 'string' ? JSON.parse(rawScopes) : rawScopes;
      if (scopes.length > 0) {
        const match = scopes.find(
          (s) => s.collection === collection || s.collection === '*',
        );
        if (!match) return false;
        if (!match.actions.includes(action) && !match.actions.includes('*')) return false;
      }
    }
    return true;
  }
  return checkPermission(user.id, collection, action);
}

// Broadcast webhook event
async function broadcastWebhook(
  _db: Database,
  event: string,
  collection: string,
  data: { id: string; [key: string]: any },
): Promise<void> {
  // WebhookManager.trigger() handles:
  // - matching active webhooks by event + collection
  // - queuing via Redis (webhook:queue)
  // - audit trail in zvd_webhook_deliveries
  // - retry logic via webhook:retry sorted set
  await WebhookManager.trigger(event, collection, data);
}

/** Internal columns that are operational, not user data. They leak into API
 * responses by default because Kysely returns the full row; strip them unless
 * the caller explicitly opts in with ?include_internal=1. */
const INTERNAL_COLUMNS = new Set(['search_vector', 'search_text']);

/** Cast database-side numeric strings back to JS numbers when the schema says
 * the field is numeric. Postgres `numeric/decimal` come back as strings via
 * Bun.SQL — clients shouldn't have to remember which fields to coerce. */
const NUMERIC_FIELD_TYPES = new Set([
  'number', 'integer', 'int', 'bigint', 'smallint', 'float', 'double', 'decimal',
]);

// Serialize a record's field values using the registry
async function serializeRecord(record: any, collectionDef: any): Promise<any> {
  if (!collectionDef?.fields) {
    const out = { ...record };
    for (const k of INTERNAL_COLUMNS) delete out[k];
    return out;
  }
  const result = { ...record };
  for (const field of collectionDef.fields) {
    if (result[field.name] !== undefined && result[field.name] !== null) {
      if (field.encrypted) {
        result[field.name] = await maybeDecrypt(result[field.name], true);
      }
      result[field.name] = fieldTypeRegistry.serialize(field.type, result[field.name]);
      // Numeric coercion: Postgres returns numeric/decimal as string. Cast back
      // to number so frontends can sort/format without type tricks.
      if (NUMERIC_FIELD_TYPES.has(field.type) && typeof result[field.name] === 'string') {
        const n = Number(result[field.name]);
        if (Number.isFinite(n)) result[field.name] = n;
      }
    }
  }
  // Strip internal/operational columns from public payloads.
  for (const k of INTERNAL_COLUMNS) delete result[k];
  return result;
}

/** Map Postgres SQLSTATE codes to HTTP responses with structured error bodies.
 * Without this, every constraint violation hits Hono's default error handler
 * and surfaces as 500 "Internal Server Error" plain text.
 *
 * Bun.SQL PostgresError exposes the Postgres notice fields but the property
 * names vary slightly across versions (`code` / `errno` / `routine`) — we read
 * the standard fields and fall back to message-pattern matching as a safety
 * net for cases where the SQLSTATE is missing. */
function mapPgError(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!err) return null;
  const e = err as Record<string, unknown>;
  const code = String((e.code as string | undefined) ?? (e.errno as string | undefined) ?? '');
  const message = String((e.message as string | undefined) ?? '');
  const detail  = String((e.detail  as string | undefined) ?? '');
  const constraint  = String((e.constraint_name as string | undefined) ?? (e.constraint  as string | undefined) ?? '');
  const column      = String((e.column_name     as string | undefined) ?? (e.column      as string | undefined) ?? '');

  const matchKey = /Key \(([^)]+)\)=\(([^)]+)\)(?: is not present in table "([^"]+)")?/.exec(detail || message);

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
  if (code === '23505' || /duplicate key value/i.test(message) || /unique constraint/i.test(message)) {
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
  if (code === '23502' || /not-null constraint/i.test(message) || /violates not-null/i.test(message)) {
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
        message: 'One of the values has the wrong format (likely an invalid UUID, number, or date).',
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
async function handlePgErrors<T>(c: any, fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (err) {
    const mapped = mapPgError(err);
    if (mapped) return c.json(mapped.body, mapped.status as any);
    // Surface the raw error shape so we can extend mapPgError() later.
    const e = err as { name?: string; code?: string; errno?: string; message?: string };
    console.warn('[handlePgErrors] unmapped error:', e?.name, 'code=', e?.code ?? e?.errno, 'msg=', e?.message);
    throw err;
  }
}

/** Resolve `?expand=field1,field2` for a collection: returns metadata about
 * which m2o fields the caller wants hydrated and the target collection for each. */
async function resolveExpand(
  db: Database,
  collectionDef: any,
  expandParam: string | undefined,
): Promise<Array<{ field: string; targetTable: string; targetCollection: string }>> {
  if (!expandParam || !collectionDef?.fields) return [];
  const want = new Set(expandParam.split(',').map((s) => s.trim()).filter(Boolean));
  if (want.size === 0) return [];

  const out: Array<{ field: string; targetTable: string; targetCollection: string }> = [];
  for (const f of collectionDef.fields) {
    if (!want.has(f.name)) continue;
    if ((f.type !== 'm2o' && f.type !== 'reference') || !f.options?.related_collection) continue;
    out.push({
      field: f.name,
      targetCollection: f.options.related_collection,
      targetTable: DDLManager.getTableName(f.options.related_collection),
    });
  }
  return out;
}

/** Fill an `_expanded` map on each record by fetching referenced rows in one
 * query per relation. Adds {field}_expanded: {id, label, ...} on every record. */
async function applyExpand(
  db: Database,
  records: any[],
  expandPlan: Array<{ field: string; targetTable: string; targetCollection: string }>,
): Promise<void> {
  if (expandPlan.length === 0 || records.length === 0) return;

  for (const exp of expandPlan) {
    const ids = [...new Set(records.map((r) => r[exp.field]).filter((v) => typeof v === 'string'))];
    if (ids.length === 0) continue;

    const rows = await sql<any>`
      SELECT * FROM ${sql.id(exp.targetTable)}
      WHERE id = ANY(${ids})
    `.execute(db);

    const targetDef = await DDLManager.getCollection(db, exp.targetCollection);
    const byId = new Map<string, any>();
    for (const r of rows.rows as any[]) {
      const serialized = await serializeRecord(r, targetDef);
      // Add a default `_label` (best-effort: name → title → email → id slice)
      const label = serialized.name ?? serialized.title ?? serialized.label ?? serialized.email
        ?? serialized.full_name ?? serialized.display_name ?? serialized.id?.slice(0, 8) ?? '—';
      byId.set(r.id as string, { ...serialized, _label: label });
    }
    for (const rec of records) {
      const id = rec[exp.field];
      if (id && byId.has(id)) {
        rec[`${exp.field}_expanded`] = byId.get(id);
      }
    }
  }
}

// Validate and deserialize incoming data using the registry
async function processInput(
  data: Record<string, any>,
  collectionDef: any,
  partial = false,
): Promise<{ errors: string[]; processed: Record<string, any> }> {
  const errors: string[] = [];
  const processed: Record<string, any> = {};

  if (!collectionDef?.fields) return { errors, processed: data };

  for (const field of collectionDef.fields) {
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

/** Returns the parsed VirtualConfig if the collection has source_type='virtual', else null. */
async function getVirtualConfig(db: Database, collection: string): Promise<VirtualConfig | null> {
  const meta = await DDLManager.getCollection(db, collection);
  if (meta?.source_type !== 'virtual' || !meta?.virtual_config) return null;
  return typeof meta.virtual_config === 'string'
    ? JSON.parse(meta.virtual_config)
    : meta.virtual_config;
}

/** Returns the tenant-isolated transaction DB when in multi-tenant mode, else the pool. */
function getDb(c: any, fallback: Database): Database {
  return (c.get('tenantTrx') as Database | null) ?? fallback;
}

// RFC 4122 UUID (any version). Short-circuiting here turns an otherwise
// user-visible Postgres "invalid input syntax for uuid" 500 into a clean 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}


/** Post-write side-effects: revision log, webhook, realtime broadcast, embeddings, events. */
async function afterWrite(
  db: Database,
  opts: {
    collection: string;
    recordId: string;
    action: 'create' | 'update' | 'delete';
    data: Record<string, any>;
    delta?: Record<string, any>;
    userId: string;
  },
): Promise<void> {
  const { collection, recordId, action, data, delta, userId } = opts;

  // Revision log — non-fatal
  db.insertInto('zv_revisions')
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

  const eventName =
    action === 'create' ? 'insert' : action === 'update' ? 'update' : 'delete';

  await broadcastWebhook(db, eventName, collection, data as { id: string; [key: string]: any });
  broadcastEvent(collection, eventName as 'insert' | 'update' | 'delete', data);
  broadcastDataEvent(collection, eventName, data);

  sql`SELECT pg_notify('zveltio_changes', ${JSON.stringify({
    event: `record.${action === 'create' ? 'created' : action === 'update' ? 'updated' : 'deleted'}`,
    collection,
    record_id: recordId,
    data,
    timestamp: new Date().toISOString(),
  })})`.execute(db).catch((err) => console.error('[afterWrite] pg_notify failed:', err));

  if (action !== 'delete') {
    triggerEmbedding(db, collection, recordId, data).catch((err) =>
      console.error('[afterWrite] embedding trigger failed:', err),
    );
  }

  // Invalidate query cache for this collection on every write
  invalidateQueryCache(collection).catch(() => { /* non-critical */ });

  // Trigger data_event flows (fire-and-forget — must not block the request)
  triggerDataFlows(db, collection, eventName as 'insert' | 'update' | 'delete', data).catch((err) =>
    console.error('[afterWrite] flow trigger failed:', err),
  );

  const engineEvent = action === 'create' ? 'record.created' : action === 'update' ? 'record.updated' : 'record.deleted';
  engineEvents.emit(engineEvent, {
    collection,
    record: data,
    id: recordId,
    userId,
  });
}

export function dataRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    const result = await authenticate(c, auth, db);
    if (!result) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', result.user);
    c.set('authType', result.authType as 'session' | 'api_key');
    await next();
  });

  // ── GET /:collection — List records ─────────────────────────────
  app.get('/:collection', zValidator('query', QuerySchema), async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user');
    const query = c.req.valid('query');

    if (!(await checkAccess(db, user, collection, 'read'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // ── Query result cache (Valkey) ────────────────────────────────
    // Only cache standard offset queries (no time-travel, no cursor, no virtual sources)
    const qcKey = buildQueryCacheKey(collection, user.id, c.req.url);
    if (!query.as_of && !query.cursor) {
      const cached = await getQueryCache(qcKey);
      if (cached) {
        // Still compute ETag from cached records so If-None-Match / 304 works on cache hits
        const etag = `"${await computeEtag(cached.records ?? [])}"`;
        c.header('ETag', etag);
        c.header('Cache-Control', 'private, max-age=0, must-revalidate');
        c.header('Vary', 'Cookie, X-API-Key, Authorization');
        if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
        return c.json(cached);
      }
    }

    // ── Time Travel: reconstruct state at a given point in time ────
    if (query.as_of) {
      const asOf = new Date(query.as_of);
      if (isNaN(asOf.getTime())) return c.json({ error: 'Invalid as_of date' }, 400);

      // Get the latest revision per record_id up to as_of
      // P0: use effectiveDb (tenant-isolated transaction) to prevent cross-tenant reads
      const effectiveDbTT = getDb(c, db);
      const revs = await sql<{ record_id: string; action: string; data: any }>`
        SELECT DISTINCT ON (record_id)
          record_id, action, data
        FROM zv_revisions
        WHERE collection = ${collection}
          AND created_at <= ${asOf.toISOString()}
        ORDER BY record_id, created_at DESC
      `.execute(effectiveDbTT);

      // Exclude deleted records; data column holds the snapshot
      const records = revs.rows
        .filter(r => r.action !== 'delete')
        .map(r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));

      const total = records.length;
      const offset = (query.page - 1) * query.limit;
      const page = records.slice(offset, offset + query.limit);

      return c.json({
        records: page,
        pagination: { total, page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit) },
        time_travel: { as_of: asOf.toISOString() },
      });
    }

    // Virtual collection: proxy to external API
    const virtualConfig = await getVirtualConfig(db, collection);
    if (virtualConfig) {
      try {
        // Parse query.filter into VirtualQuery.filters — translated to API URL params (no fetch-all)
        const vFilters: Array<{ field: string; op: string; value: any }> = [];
        if (query.filter) {
          try {
            const raw = JSON.parse(query.filter);
            for (const [key, value] of Object.entries(raw)) {
              if (typeof value === 'object' && value !== null) {
                const [op, val] = Object.entries(value)[0] as [string, any];
                vFilters.push({ field: key, op, value: val });
              } else {
                vFilters.push({ field: key, op: 'eq', value });
              }
            }
          } catch { /* invalid JSON — skip */ }
        }

        const { data, total } = await virtualList(virtualConfig, {
          filters: vFilters,
          sort: query.sort ? { field: query.sort, direction: query.order } : undefined,
          page: query.page,
          limit: query.limit,
          search: query.search,
        });
        return c.json({
          records: data,
          pagination: {
            total,
            page: query.page,
            limit: query.limit,
            pages: Math.ceil(total / query.limit),
          },
        });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(collection);

    // Build the set of columns clients are allowed to sort/filter by. Hitting
    // Postgres with an unknown column surfaces as a 500 ("column X does not
    // exist") — we want a clean 400 at the edge instead.
    const rawFields: any[] = typeof (collectionDef as any).fields === 'string'
      ? JSON.parse((collectionDef as any).fields)
      : ((collectionDef as any).fields ?? []);
    const SYSTEM_COLS = new Set([
      'id', 'created_at', 'updated_at', 'status', 'created_by', 'updated_by',
    ]);
    const allowedCols = new Set<string>([
      ...SYSTEM_COLS,
      ...rawFields.map((f: any) => f.name).filter(Boolean),
    ]);

    // Parse filters — two supported formats (both can be used together):
    //
    // 1. JSON:    ?filter={"price":{"gt":50},"title":{"like":"pro"}}
    // 2. Bracket: ?price[gt]=50&title[like]=pro  (simpler for curl/browser)
    //
    // When both are provided for the same field, JSON takes precedence.
    const OP_ALIAS: Record<string, FilterCondition['op']> = {
      eq: 'eq', neq: 'neq', lt: 'lt', lte: 'lte', gt: 'gt', gte: 'gte',
      like: 'ilike', contains: 'ilike', ilike: 'ilike',
      in: 'in', not_in: 'not_in',
      null: 'null', is_null: 'null',
      not_null: 'not_null', is_not_null: 'not_null',
    };

    const filters: Record<string, FilterCondition> = {};

    // Format 2: bracket syntax — parse before JSON so JSON can override
    const BRACKET_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_]+)\]$/;
    for (const [paramKey, paramVal] of Object.entries(c.req.query())) {
      const m = BRACKET_RE.exec(paramKey);
      if (!m) continue;
      const [, field, op] = m;
      if (!allowedCols.has(field)) continue; // silently skip unknown fields
      const mappedOp = OP_ALIAS[op];
      if (!mappedOp) continue;
      // Coerce numeric-looking values to numbers for comparison operators
      const numericOps = new Set<FilterCondition['op']>(['gt', 'gte', 'lt', 'lte']);
      const value = numericOps.has(mappedOp) && paramVal !== '' && !isNaN(Number(paramVal))
        ? Number(paramVal)
        : paramVal;
      filters[field] = { op: mappedOp, value };
    }

    // Format 1: JSON (overrides bracket for same field)
    if (query.filter) {
      let raw: Record<string, any> | null = null;
      try { raw = JSON.parse(query.filter); } catch { /* malformed JSON — ignore */ }
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) {
          if (!allowedCols.has(key)) {
            return c.json({ error: `Unknown filter field: '${key}'` }, 400);
          }
          if (typeof value === 'object' && value !== null) {
            const [op, val] = Object.entries(value)[0] as [string, any];
            const mappedOp = OP_ALIAS[op];
            if (mappedOp) filters[key] = { op: mappedOp, value: val };
          } else {
            filters[key] = { op: 'eq', value };
          }
        }
      }
    }

    if (query.sort && !allowedCols.has(query.sort)) {
      return c.json({ error: `Unknown sort field: '${query.sort}'` }, 400);
    }

    // ── RLS injection ──────────────────────────────────────────────
    // Merge row-level security filters into existing query filters.
    // RLS conditions are ANDed with any user-supplied filters.
    const rlsFilters = await getRlsFilters(collection, user, c.get('authType'));
    for (const { field, condition } of rlsFilters) {
      filters[field] = condition; // RLS wins over same-field user filter
    }

    const effectiveDb = getDb(c, db);
    const sortField = query.sort ?? 'created_at';

    // ── Cursor-based pagination ────────────────────────────────────
    // Used when `cursor` is provided and page is still default (1).
    // Avoids OFFSET cost on large tables.
    const useCursor = !!query.cursor && query.page === 1;
    let result: { records: any[]; total: number };

    if (useCursor) {
      let decoded: { id: string; val: any } = { id: '', val: null };
      try {
        decoded = JSON.parse(Buffer.from(query.cursor!, 'base64url').toString());
      } catch { /* malformed cursor — fall through to offset path */ }

      if (decoded.id && decoded.val !== undefined) {
        // Build keyset query directly with Kysely for proper compound pagination
        // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
        let kQuery = (effectiveDb as any)
          .selectFrom(tableName)
          .selectAll();

        // Apply existing filters
        for (const [field, cond] of Object.entries(filters)) {
          if (cond.op === 'eq') kQuery = kQuery.where(field, '=', cond.value);
          else if (cond.op === 'neq') kQuery = kQuery.where(field, '!=', cond.value);
          else if (cond.op === 'lt') kQuery = kQuery.where(field, '<', cond.value);
          else if (cond.op === 'lte') kQuery = kQuery.where(field, '<=', cond.value);
          else if (cond.op === 'gt') kQuery = kQuery.where(field, '>', cond.value);
          else if (cond.op === 'gte') kQuery = kQuery.where(field, '>=', cond.value);
        }

        // Add keyset condition (compound: sort col + tiebreak by id)
        if (query.order === 'asc') {
          kQuery = kQuery.where(
            sql`(${sql.ref(sortField)} > ${decoded.val}) OR (${sql.ref(sortField)} = ${decoded.val} AND id > ${decoded.id})`,
          );
          kQuery = kQuery.orderBy(sortField, 'asc').orderBy('id', 'asc');
        } else {
          kQuery = kQuery.where(
            sql`(${sql.ref(sortField)} < ${decoded.val}) OR (${sql.ref(sortField)} = ${decoded.val} AND id < ${decoded.id})`,
          );
          kQuery = kQuery.orderBy(sortField, 'desc').orderBy('id', 'desc');
        }

        // Fetch limit+1 to detect whether a next page exists without a count query
        kQuery = kQuery.limit(query.limit + 1);
        const rows: any[] = await kQuery.execute();
        const hasMore = rows.length > query.limit;
        result = { records: hasMore ? rows.slice(0, query.limit) : rows, total: hasMore ? -1 : rows.length };
      } else {
        // Malformed cursor — fall back to offset
        const offset = (query.page - 1) * query.limit;
        result = await tracedQuery(`${tableName}.list`, () => dynamicSelect(effectiveDb, tableName, {
          filters,
          sort: query.sort ? { field: query.sort, direction: query.order } : undefined,
          limit: query.limit,
          offset,
          fts: query.search ? query.search.trim().substring(0, 500) : undefined,
          hasTrgm: !!(collectionDef as any).has_trgm,
        }));
      }
    } else {
      // Standard OFFSET-based pagination (backwards-compatible)
      const offset = (query.page - 1) * query.limit;
      // FTS + filters run in a single query via dynamicSelect (fts param adds
      // search_vector @@ websearch_to_tsquery() alongside any other WHERE conditions)
      result = await dynamicSelect(effectiveDb, tableName, {
        filters,
        sort: query.sort ? { field: query.sort, direction: query.order } : undefined,
        limit: query.limit,
        offset,
        fts: query.search ? query.search.trim().substring(0, 500) : undefined,
        hasTrgm: !!(collectionDef as any).has_trgm,
      });
    }

    const colAccess = await getColumnAccess(db, collection, user.role ?? 'public');
    const serialized = (await Promise.all(result.records.map((r) => serializeRecord(r, collectionDef))))
      .map((r) => applyColumnAccess(r, colAccess));

    // ── Expand m2o relations on demand (?expand=customer_id,author_id) ──
    const expandPlan = await resolveExpand(effectiveDb, collectionDef, c.req.query('expand'));
    await applyExpand(effectiveDb, serialized, expandPlan);

    // ── ETag + Cache-Control ───────────────────────────────────────
    const etag = `"${await computeEtag(serialized)}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, max-age=0, must-revalidate');
    c.header('Vary', 'Cookie, X-API-Key, Authorization');

    const ifNoneMatch = c.req.header('If-None-Match');
    if (ifNoneMatch && ifNoneMatch === etag) {
      return c.body(null, 304);
    }

    // ── Build next_cursor ─────────────────────────────────────────
    // Cursor mode: result.total === -1 means hasMore (limit+1 trick returned extra row)
    // Offset mode: compare offset+returned vs total count
    let next_cursor: string | null = null;
    const offsetHasMore = result.total >= 0
      ? (query.page - 1) * query.limit + serialized.length < result.total
      : false;
    const cursorHasMore = result.total === -1; // set by limit+1 trick above
    if (serialized.length > 0 && (cursorHasMore || offsetHasMore)) {
      const lastRow = serialized[serialized.length - 1];
      if (lastRow?.id !== undefined) {
        next_cursor = Buffer.from(
          JSON.stringify({ id: lastRow.id, val: lastRow[sortField] ?? lastRow.created_at }),
        ).toString('base64url');
      }
    }

    // Response shape matches the rest of the list endpoints (time-travel, virtual)
    // and the contract consumed by Studio + SDK: { records, pagination, next_cursor? }.
    // A prior refactor renamed these to { data, total, page, limit, pages } which
    // silently broke every client — the studio data tab was stuck on its spinner
    // because `dataRes.records` was undefined and rendering threw on records.length.
    const listResponse = {
      records: serialized,
      pagination: {
        total: result.total >= 0 ? result.total : undefined,
        page: query.page,
        limit: query.limit,
        pages: result.total >= 0 ? Math.ceil(result.total / query.limit) : undefined,
      },
      next_cursor,
    };

    // Cache the response (fire-and-forget, non-blocking)
    if (!query.as_of && !query.cursor) {
      setQueryCache(qcKey, listResponse).catch(() => { /* non-critical */ });
    }

    return c.json(listResponse);
  });

  // ── POST /:collection/bulk — Bulk insert ─────────────────────────
  app.post('/:collection/bulk', async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user');

    if (!(await checkAccess(db, user, collection, 'create'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!Array.isArray(body?.records) || body.records.length === 0) {
      return c.json({ error: 'Body must be { records: [...] } with at least one item' }, 400);
    }
    if (body.records.length > 500) {
      return c.json({ error: 'Bulk insert limited to 500 records per request' }, 400);
    }

    const tableName = DDLManager.getTableName(collection);
    const effectiveDb = getDb(c, db);
    const created: any[] = [];
    const errors: Array<{ index: number; errors: string[] }> = [];

    await (effectiveDb as any).transaction().execute(async (trx: Database) => {
      for (let i = 0; i < body.records.length; i++) {
        const { errors: valErrors, processed } = await processInput(body.records[i], collectionDef);
        if (valErrors.length > 0) { errors.push({ index: i, errors: valErrors }); continue; }
        const record = await dynamicInsert(trx, tableName, { ...processed, created_by: user.id, updated_by: user.id });
        created.push(record);
      }
    });

    for (const record of created) {
      afterWrite(effectiveDb, { collection, recordId: record.id, action: 'create', data: record, userId: user.id }).catch(() => {});
    }

    return c.json({ created: created.length, records: created, errors }, errors.length > 0 ? 207 : 201);
  });

  // ── PATCH /:collection/bulk — Bulk partial update ─────────────────
  app.patch('/:collection/bulk', async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user');

    if (!(await checkAccess(db, user, collection, 'update'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!Array.isArray(body?.records) || body.records.length === 0) {
      return c.json({ error: 'Body must be { records: [{id, ...fields}] }' }, 400);
    }
    if (body.records.length > 500) {
      return c.json({ error: 'Bulk update limited to 500 records per request' }, 400);
    }
    if (body.records.some((r: any) => !isUuid(r?.id))) {
      return c.json({ error: 'Every record must have a valid UUID id' }, 400);
    }

    const tableName = DDLManager.getTableName(collection);
    const effectiveDb = getDb(c, db);
    const updated: any[] = [];
    const errors: Array<{ index: number; id: string; errors: string[] }> = [];

    await (effectiveDb as any).transaction().execute(async (trx: Database) => {
      for (let i = 0; i < body.records.length; i++) {
        const { id, ...fields } = body.records[i];
        const { errors: valErrors, processed } = await processInput(fields, collectionDef, true);
        if (valErrors.length > 0) { errors.push({ index: i, id, errors: valErrors }); continue; }
        const record = await dynamicUpdate(trx, tableName, id, { ...processed, updated_by: user.id });
        if (record) updated.push(record);
        else errors.push({ index: i, id, errors: ['Record not found'] });
      }
    });

    for (const record of updated) {
      afterWrite(effectiveDb, { collection, recordId: record.id, action: 'update', data: record, userId: user.id }).catch(() => {});
    }

    return c.json({ updated: updated.length, records: updated, errors }, errors.length > 0 ? 207 : 200);
  });

  // ── DELETE /:collection/bulk — Bulk delete ────────────────────────
  app.delete('/:collection/bulk', async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user');

    if (!(await checkAccess(db, user, collection, 'delete'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (!(await DDLManager.getCollection(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const body = await c.req.json().catch(() => null);
    if (!Array.isArray(body?.ids) || body.ids.length === 0) {
      return c.json({ error: 'Body must be { ids: [...] }' }, 400);
    }
    if (body.ids.length > 500) {
      return c.json({ error: 'Bulk delete limited to 500 records per request' }, 400);
    }
    if (body.ids.some((id: any) => !isUuid(id))) {
      return c.json({ error: 'All ids must be valid UUIDs' }, 400);
    }

    const tableName = DDLManager.getTableName(collection);
    const effectiveDb = getDb(c, db);

    const existing = await (effectiveDb as any)
      .selectFrom(tableName)
      .selectAll()
      .where('id', 'in', body.ids)
      .execute();

    await (effectiveDb as any)
      .deleteFrom(tableName)
      .where('id', 'in', body.ids)
      .execute();

    for (const record of existing) {
      afterWrite(effectiveDb, { collection, recordId: record.id, action: 'delete', data: record, userId: user.id }).catch(() => {});
    }

    return c.json({ deleted: existing.length, ids: existing.map((r: any) => r.id) });
  });

  // ── GET /:collection/:id — Get single record ─────────────────────
  app.get('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');
    const asOfRaw = c.req.query('as_of');

    if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

    if (!(await checkAccess(db, user, collection, 'read'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // ── Time Travel: single record at a given point in time ────────
    if (asOfRaw) {
      const asOf = new Date(asOfRaw);
      if (isNaN(asOf.getTime())) return c.json({ error: 'Invalid as_of date' }, 400);

      // P0: use effectiveDb for tenant isolation in time-travel queries
      const effectiveDbTTSingle = getDb(c, db);
      const rev = await sql<{ action: string; data: any; created_at: string }>`
        SELECT action, data, created_at
        FROM zv_revisions
        WHERE collection = ${collection}
          AND record_id = ${id}
          AND created_at <= ${asOf.toISOString()}
        ORDER BY created_at DESC
        LIMIT 1
      `.execute(effectiveDbTTSingle);

      if (rev.rows.length === 0) return c.json({ error: 'Record not found at this point in time' }, 404);
      if (rev.rows[0].action === 'delete') return c.json({ error: 'Record was deleted before this point in time' }, 404);

      const data = typeof rev.rows[0].data === 'string' ? JSON.parse(rev.rows[0].data) : rev.rows[0].data;
      return c.json({ record: data, time_travel: { as_of: asOf.toISOString(), snapshot_at: rev.rows[0].created_at } });
    }

    // Virtual collection: proxy to external API
    const virtualConfigSingle = await getVirtualConfig(db, collection);
    if (virtualConfigSingle) {
      try {
        const record = await virtualGetOne(virtualConfigSingle, id);
        if (!record) return c.json({ error: 'Record not found' }, 404);
        return c.json({ record });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(collection);
    const effectiveDb = getDb(c, db);

    // Build query with RLS conditions so a user cannot fetch a record
    // they're not allowed to see by guessing its ID.
    const rlsSingle = await getRlsFilters(collection, user, c.get('authType'));
    // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
    let recordQuery = (effectiveDb as any)
      .selectFrom(tableName)
      .selectAll()
      .where('id', '=', id);

    for (const { field, condition } of rlsSingle) {
      if (condition.op === 'eq') recordQuery = recordQuery.where(field, '=', condition.value);
      else if (condition.op === 'neq') recordQuery = recordQuery.where(field, '!=', condition.value);
    }

    const record = await recordQuery.executeTakeFirst();

    if (!record) return c.json({ error: 'Record not found' }, 404);

    const colAccess = await getColumnAccess(db, collection, user.role ?? 'public');
    const serializedRecord = applyColumnAccess(await serializeRecord(record, collectionDef), colAccess);

    // Expand m2o relations on demand
    const singleExpand = await resolveExpand(effectiveDb, collectionDef, c.req.query('expand'));
    if (singleExpand.length > 0) {
      await applyExpand(effectiveDb, [serializedRecord], singleExpand);
    }

    // ETag + Cache-Control for single record
    const singleEtag = `"${await computeEtag([serializedRecord])}"`;
    c.header('ETag', singleEtag);
    c.header('Cache-Control', 'private, max-age=0, must-revalidate');
    c.header('Vary', 'Cookie, X-API-Key, Authorization');

    const ifNoneMatchSingle = c.req.header('If-None-Match');
    if (ifNoneMatchSingle && ifNoneMatchSingle === singleEtag) {
      return c.body(null, 304);
    }

    return c.json(serializedRecord);
  });

  // ── POST /:collection — Create record ────────────────────────────
  app.post('/:collection', async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user');

    if (!(await checkAccess(db, user, collection, 'create'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Virtual collection: proxy create to external API
    const virtualConfigCreate = await getVirtualConfig(db, collection);
    if (virtualConfigCreate) {
      try {
        const body = await c.req.json();
        const record = await virtualCreate(virtualConfigCreate, body);
        return c.json({ record }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(collection);
    const body = await c.req.json();

    const { errors, processed } = await processInput(body, collectionDef);
    if (errors.length > 0) return c.json({ errors }, 422);

    const colAccessCreate = await getColumnAccess(db, collection, user.role ?? 'public');
    const { data: allowedData, blocked: blockedCreate } = filterWritableFields(processed, colAccessCreate);
    if (blockedCreate.length > 0) {
      return c.json({ error: `Fields are read-only for your role: ${blockedCreate.join(', ')}` }, 403);
    }

    const effectiveDb = getDb(c, db);
    const toInsert = { ...allowedData, created_by: user.id, updated_by: user.id };
    const result = await handlePgErrors(c, async () => {
      const record = await tracedQuery(`${tableName}.create`, () => dynamicInsert(effectiveDb, tableName, toInsert));
      await afterWrite(effectiveDb, { collection, recordId: record.id, action: 'create', data: record, userId: user.id });
      return c.json(await serializeRecord(record, collectionDef), 201);
    });
    return result as Response;
  });

  // ── PUT /:collection/:id — Replace record ────────────────────────
  app.put('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');

    if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

    if (!(await checkAccess(db, user, collection, 'update'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Virtual collection: proxy update to external API
    const virtualConfigPut = await getVirtualConfig(db, collection);
    if (virtualConfigPut) {
      try {
        const body = await c.req.json();
        const record = await virtualUpdate(virtualConfigPut, id, body);
        return c.json({ record });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(collection);
    const body = await c.req.json();

    const { errors, processed } = await processInput(body, collectionDef);
    if (errors.length > 0) return c.json({ errors }, 422);

    const effectiveDb = getDb(c, db);
    const toUpdate = { ...processed, updated_by: user.id };
    const result = await handlePgErrors(c, async () => {
      const record = await tracedQuery(`${tableName}.update`, () => dynamicUpdate(effectiveDb, tableName, id, toUpdate));
      if (!record) return c.json({ error: 'Record not found' }, 404);
      await afterWrite(effectiveDb, { collection, recordId: id, action: 'update', data: record, userId: user.id });
      return c.json(await serializeRecord(record, collectionDef));
    });
    return result as Response;
  });

  // ── PATCH /:collection/:id — Partial update ───────────────────────
  app.patch('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');

    if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

    if (!(await checkAccess(db, user, collection, 'update'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Virtual collection: proxy patch to external API
    const virtualConfigPatch = await getVirtualConfig(db, collection);
    if (virtualConfigPatch) {
      try {
        const body = await c.req.json();
        const record = await virtualUpdate(virtualConfigPatch, id, body);
        return c.json({ record });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(collection);
    const body = await c.req.json();

    const { errors, processed } = await processInput(body, collectionDef, true);
    if (errors.length > 0) return c.json({ errors }, 422);

    const colAccessPatch = await getColumnAccess(db, collection, user.role ?? 'public');
    const { data: allowedPatch, blocked: blockedPatch } = filterWritableFields(processed, colAccessPatch);
    if (blockedPatch.length > 0) {
      return c.json({ error: `Fields are read-only for your role: ${blockedPatch.join(', ')}` }, 403);
    }

    const effectiveDb = getDb(c, db);
    const toUpdate = { ...allowedPatch, updated_by: user.id };
    const result = await handlePgErrors(c, async () => {
      const record = await dynamicUpdate(effectiveDb, tableName, id, toUpdate);
      if (!record) return c.json({ error: 'Record not found' }, 404);
      await afterWrite(effectiveDb, { collection, recordId: id, action: 'update', data: record, delta: body, userId: user.id });
      return c.json(await serializeRecord(record, collectionDef));
    });
    return result as Response;
  });

  // ── DELETE /:collection/:id — Delete record ───────────────────────
  app.delete('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');

    if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

    if (!(await checkAccess(db, user, collection, 'delete'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Virtual collection: proxy delete to external API
    const virtualConfigDelete = await getVirtualConfig(db, collection);
    if (virtualConfigDelete) {
      try {
        await virtualDelete(virtualConfigDelete, id);
        return c.json({ success: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    if (!(await DDLManager.getCollection(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const tableName = DDLManager.getTableName(collection);
    const effectiveDb = getDb(c, db);

    // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
    // Fetch existing for revision log, then delete atomically
    const existing = await (effectiveDb as any)
      .selectFrom(tableName)
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!existing) return c.json({ error: 'Record not found' }, 404);

    const deleted = await tracedQuery(`${tableName}.delete`, () => dynamicDelete(effectiveDb, tableName, id));
    if (!deleted) return c.json({ error: 'Record not found' }, 404);

    await afterWrite(effectiveDb, { collection, recordId: id, action: 'delete', data: existing, userId: user.id });

    return c.json({ success: true, id });
  });

  return app;
}
