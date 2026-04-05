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
import { escapeLike } from '../lib/query-utils.js';
import { hashApiKey } from '../lib/api-key-hash.js';
import { maybeEncrypt, maybeDecrypt } from '../lib/field-crypto.js';

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
  return checkPermission(user.id, `data:${collection}`, action);
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

// Serialize a record's field values using the registry
async function serializeRecord(record: any, collectionDef: any): Promise<any> {
  if (!collectionDef?.fields) return record;
  const result = { ...record };
  for (const field of collectionDef.fields) {
    if (result[field.name] !== undefined) {
      // Decrypt encrypted fields before serialization
      if (field.encrypted) {
        result[field.name] = await maybeDecrypt(result[field.name], true);
      }
      result[field.name] = fieldTypeRegistry.serialize(field.type, result[field.name]);
    }
  }
  return result;
}

// Validate and deserialize incoming data using the registry
async function processInput(
  data: Record<string, any>,
  collectionDef: any,
): Promise<{ errors: string[]; processed: Record<string, any> }> {
  const errors: string[] = [];
  const processed: Record<string, any> = {};

  if (!collectionDef?.fields) return { errors, processed: data };

  for (const field of collectionDef.fields) {
    const typeDef = fieldTypeRegistry.get(field.type);
    if (!typeDef || typeDef.db.virtual) continue;

    const value = data[field.name];

    // Validate
    const error = fieldTypeRegistry.validate(field.type, value, field);
    if (error) errors.push(error);

    // Deserialize
    if (value !== undefined) {
      const deserialized = fieldTypeRegistry.deserialize(field.type, value);
      // Encrypt fields marked as encrypted
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

    // Parse filters from JSON query param into safe FilterCondition map
    const filters: Record<string, FilterCondition> = {};
    if (query.filter) {
      try {
        const raw = JSON.parse(query.filter);
        const opAlias: Record<string, FilterCondition['op']> = {
          eq: 'eq', neq: 'neq', lt: 'lt', lte: 'lte', gt: 'gt', gte: 'gte',
          like: 'ilike', contains: 'ilike', ilike: 'ilike',
          in: 'in', not_in: 'not_in',
          null: 'null', is_null: 'null',
          not_null: 'not_null', is_not_null: 'not_null',
        };
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value === 'object' && value !== null) {
            const [op, val] = Object.entries(value)[0] as [string, any];
            const mappedOp = opAlias[op];
            if (mappedOp) filters[key] = { op: mappedOp, value: val };
          } else {
            filters[key] = { op: 'eq', value };
          }
        }
      } catch { /* invalid JSON — skip */ }
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
        result = await dynamicSelect(effectiveDb, tableName, {
          filters,
          sort: query.sort ? { field: query.sort, direction: query.order } : undefined,
          limit: query.limit,
          offset,
          fts: query.search ? escapeLike(query.search.trim().substring(0, 500)) : undefined,
        });
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
        fts: query.search ? escapeLike(query.search.trim().substring(0, 500)) : undefined,
      });
    }

    const serialized = await Promise.all(result.records.map((r) => serializeRecord(r, collectionDef)));

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

    return c.json({
      data: serialized,
      total: result.total >= 0 ? result.total : undefined,
      page: query.page,
      limit: query.limit,
      pages: result.total >= 0 ? Math.ceil(result.total / query.limit) : undefined,
      next_cursor,
    });
  });

  // ── GET /:collection/:id — Get single record ─────────────────────
  app.get('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');
    const asOfRaw = c.req.query('as_of');

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

    // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
    const record = await (effectiveDb as any)
      .selectFrom(tableName)
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!record) return c.json({ error: 'Record not found' }, 404);

    const serializedRecord = await serializeRecord(record, collectionDef);

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

    const effectiveDb = getDb(c, db);
    const toInsert = { ...processed, created_by: user.id, updated_by: user.id };
    const record = await dynamicInsert(effectiveDb, tableName, toInsert);

    await afterWrite(effectiveDb, { collection, recordId: record.id, action: 'create', data: record, userId: user.id });

    return c.json(await serializeRecord(record, collectionDef));
  });

  // ── PUT /:collection/:id — Replace record ────────────────────────
  app.put('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');

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
    const record = await dynamicUpdate(effectiveDb, tableName, id, toUpdate);
    if (!record) return c.json({ error: 'Record not found' }, 404);

    await afterWrite(effectiveDb, { collection, recordId: id, action: 'update', data: record, userId: user.id });

    return c.json(await serializeRecord(record, collectionDef));
  });

  // ── PATCH /:collection/:id — Partial update ───────────────────────
  app.patch('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');

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

    const { errors, processed } = await processInput(body, collectionDef);
    if (errors.length > 0) return c.json({ errors }, 422);

    const effectiveDb = getDb(c, db);
    const toUpdate = { ...processed, updated_by: user.id };
    const record = await dynamicUpdate(effectiveDb, tableName, id, toUpdate);
    if (!record) return c.json({ error: 'Record not found' }, 404);

    await afterWrite(effectiveDb, { collection, recordId: id, action: 'update', data: record, delta: body, userId: user.id });

    return c.json(await serializeRecord(record, collectionDef));
  });

  // ── DELETE /:collection/:id — Delete record ───────────────────────
  app.delete('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');

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

    const deleted = await dynamicDelete(effectiveDb, tableName, id);
    if (!deleted) return c.json({ error: 'Record not found' }, 404);

    await afterWrite(effectiveDb, { collection, recordId: id, action: 'delete', data: existing, userId: user.id });

    return c.json({ success: true, id });
  });

  return app;
}
