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
import {
  dynamicSelect,
  dynamicInsert,
  dynamicUpdate,
  dynamicDelete,
  type FilterCondition,
} from '../db/dynamic.js';
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
});

// Authenticate request — session or API key
async function authenticate(c: any, auth: any): Promise<{ user: any; authType: string } | null> {
  // Try session
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session) return { user: session.user, authType: 'session' };

  // Try API key
  const rawKey =
    c.req.header('X-API-Key') || c.req.header('Authorization')?.replace('Bearer ', '');

  if (rawKey?.startsWith('zvk_')) {
    const apiKey = await validateApiKey(c.get('db'), rawKey);
    if (apiKey) {
      return {
        user: { id: `apikey:${apiKey.id}`, name: apiKey.name, role: 'api_key' },
        authType: 'api_key',
      };
    }
  }

  return null;
}

// HMAC-SHA256 hash for API key validation — must match admin.ts key creation and api-key-guard.ts.
// Plain SHA-256 (without secret) would silently never match keys created by admin.ts.
async function hashKey(key: string): Promise<string> {
  const authSecret = process.env.BETTER_AUTH_SECRET ?? process.env.SECRET_KEY ?? '';
  if (!authSecret) throw new Error('Server configuration error: auth secret not set');
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(authSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const hashBuffer = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(key));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function validateApiKey(db: Database, rawKey: string): Promise<any | null> {
  const hash = await hashKey(rawKey);
  const apiKey = await db
    .selectFrom('zv_api_keys' as any)
    .selectAll()
    .where('key_hash' as any, '=', hash)
    .where('is_active' as any, '=', true)
    .executeTakeFirst();

  if (!apiKey) return null;
  if ((apiKey as any).expires_at && new Date((apiKey as any).expires_at) < new Date()) return null;

  // Update last_used_at — fire-and-forget; non-blocking on hot path
  db.updateTable('zv_api_keys' as any)
    .set({ last_used_at: new Date() } as any)
    .where('id' as any, '=', (apiKey as any).id)
    .execute()
    .catch(() => { /* non-fatal */ });

  return apiKey;
}

async function checkAccess(
  db: Database,
  user: any,
  collection: string,
  action: string,
): Promise<boolean> {
  if (user.role === 'admin') return true;
  if (user.role === 'api_key') {
    // API keys cannot access system tables
    const tableName = DDLManager.getTableName(collection);
    if (tableName.startsWith('zv_') && !tableName.startsWith('zvd_')) return false;
    return true; // API key scope checked separately
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
  await WebhookManager.trigger(event as any, collection, data);
}

// Serialize a record's field values using the registry
function serializeRecord(record: any, collectionDef: any): any {
  if (!collectionDef?.fields) return record;
  const result = { ...record };
  for (const field of collectionDef.fields) {
    if (result[field.name] !== undefined) {
      result[field.name] = fieldTypeRegistry.serialize(field.type, result[field.name]);
    }
  }
  return result;
}

// Validate and deserialize incoming data using the registry
function processInput(
  data: Record<string, any>,
  collectionDef: any,
): { errors: string[]; processed: Record<string, any> } {
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
      processed[field.name] = fieldTypeRegistry.deserialize(field.type, value);
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

export function dataRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    const result = await authenticate(c, auth);
    if (!result) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', result.user);
    c.set('authType', result.authType);
    await next();
  });

  // ── GET /:collection — List records ─────────────────────────────
  app.get('/:collection', zValidator('query', QuerySchema), async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user') as any;
    const query = c.req.valid('query');

    if (!(await checkAccess(db, user, collection, 'read'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // ── Time Travel: reconstruct state at a given point in time ────
    if (query.as_of) {
      const asOf = new Date(query.as_of);
      if (isNaN(asOf.getTime())) return c.json({ error: 'Invalid as_of date' }, 400);

      // Get the latest revision per record_id up to as_of
      const revs = await sql<{ record_id: string; action: string; data: any }>`
        SELECT DISTINCT ON (record_id)
          record_id, action, data
        FROM zv_revisions
        WHERE collection = ${collection}
          AND created_at <= ${asOf.toISOString()}
        ORDER BY record_id, created_at DESC
      `.execute(db);

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
    const offset = (query.page - 1) * query.limit;

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

    // FTS + filters run in a single query via dynamicSelect (fts param adds
    // search_vector @@ websearch_to_tsquery() alongside any other WHERE conditions)
    const result = await dynamicSelect(db, tableName, {
      filters,
      sort: query.sort ? { field: query.sort, direction: query.order } : undefined,
      limit: query.limit,
      offset,
      fts: query.search ? query.search.trim().substring(0, 500) : undefined,
    });

    const serialized = result.records.map((r) => serializeRecord(r, collectionDef));

    return c.json({
      records: serialized,
      pagination: {
        total: result.total,
        page: query.page,
        limit: query.limit,
        pages: Math.ceil(result.total / query.limit),
      },
    });
  });

  // ── GET /:collection/:id — Get single record ─────────────────────
  app.get('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user') as any;
    const asOfRaw = c.req.query('as_of');

    if (!(await checkAccess(db, user, collection, 'read'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // ── Time Travel: single record at a given point in time ────────
    if (asOfRaw) {
      const asOf = new Date(asOfRaw);
      if (isNaN(asOf.getTime())) return c.json({ error: 'Invalid as_of date' }, 400);

      const rev = await sql<{ action: string; data: any; created_at: string }>`
        SELECT action, data, created_at
        FROM zv_revisions
        WHERE collection = ${collection}
          AND record_id = ${id}
          AND created_at <= ${asOf.toISOString()}
        ORDER BY created_at DESC
        LIMIT 1
      `.execute(db);

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

    const record = await (db as any)
      .selectFrom(tableName)
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!record) return c.json({ error: 'Record not found' }, 404);

    return c.json({ record: serializeRecord(record, collectionDef) });
  });

  // ── POST /:collection — Create record ────────────────────────────
  app.post('/:collection', async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user') as any;

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

    const { errors, processed } = processInput(body, collectionDef);
    if (errors.length > 0) return c.json({ errors }, 422);

    const toInsert = { ...processed, created_by: user.id, updated_by: user.id };
    const record = await dynamicInsert(db, tableName, toInsert);

    // Record revision
    await db
      .insertInto('zv_revisions' as any)
      .values({
        collection,
        record_id: record.id,
        action: 'create',
        data: JSON.stringify(record),
        user_id: user.id,
      } as any)
      .execute()
      .catch(() => { /* non-fatal */ });

    await broadcastWebhook(db, 'insert', collection, record as { id: string; [key: string]: any });
    broadcastEvent(collection, 'insert', record);
    sql`SELECT pg_notify('zveltio_changes', ${JSON.stringify({
      event: 'record.created',
      collection,
      record_id: record.id,
      data: record,
      timestamp: new Date().toISOString(),
    })})`.execute(db).catch(() => { /* non-fatal */ });

    // AI embedding hook — async, non-blocking
    triggerEmbedding(db, collection, record.id, record).catch(() => { /* non-fatal */ });

    // Extension event bus — synchronous, in-process
    engineEvents.emit('record.created', { collection, record: record, userId: user.id });

    return c.json({ record: serializeRecord(record, collectionDef) }, 201);
  });

  // ── PUT /:collection/:id — Replace record ────────────────────────
  app.put('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user') as any;

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

    const { errors, processed } = processInput(body, collectionDef);
    if (errors.length > 0) return c.json({ errors }, 422);

    const toUpdate = { ...processed, updated_by: user.id };
    const record = await dynamicUpdate(db, tableName, id, toUpdate);
    if (!record) return c.json({ error: 'Record not found' }, 404);

    await db
      .insertInto('zv_revisions' as any)
      .values({
        collection,
        record_id: id,
        action: 'update',
        data: JSON.stringify(record),
        user_id: user.id,
      } as any)
      .execute()
      .catch(() => { /* non-fatal */ });

    await broadcastWebhook(db, 'update', collection, record as { id: string; [key: string]: any });
    broadcastEvent(collection, 'update', record);
    sql`SELECT pg_notify('zveltio_changes', ${JSON.stringify({
      event: 'record.updated',
      collection,
      record_id: id,
      data: record,
      timestamp: new Date().toISOString(),
    })})`.execute(db).catch(() => { /* non-fatal */ });

    // AI embedding hook — async, non-blocking
    triggerEmbedding(db, collection, id, record).catch(() => { /* non-fatal */ });

    // Extension event bus — synchronous, in-process
    engineEvents.emit('record.updated', { collection, record: record, userId: user.id });

    return c.json({ record: serializeRecord(record, collectionDef) });
  });

  // ── PATCH /:collection/:id — Partial update ───────────────────────
  app.patch('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user') as any;

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

    const { errors, processed } = processInput(body, collectionDef);
    if (errors.length > 0) return c.json({ errors }, 422);

    const toUpdate = { ...processed, updated_by: user.id };
    const record = await dynamicUpdate(db, tableName, id, toUpdate);
    if (!record) return c.json({ error: 'Record not found' }, 404);

    await db
      .insertInto('zv_revisions' as any)
      .values({
        collection,
        record_id: id,
        action: 'update',
        data: JSON.stringify(record),
        delta: JSON.stringify(body),
        user_id: user.id,
      } as any)
      .execute()
      .catch(() => { /* non-fatal */ });

    await broadcastWebhook(db, 'update', collection, record as { id: string; [key: string]: any });
    broadcastEvent(collection, 'update', record);
    sql`SELECT pg_notify('zveltio_changes', ${JSON.stringify({
      event: 'record.updated',
      collection,
      record_id: id,
      data: record,
      timestamp: new Date().toISOString(),
    })})`.execute(db).catch(() => { /* non-fatal */ });

    // AI embedding hook — async, non-blocking
    triggerEmbedding(db, collection, id, record).catch(() => { /* non-fatal */ });

    // Extension event bus — synchronous, in-process
    engineEvents.emit('record.updated', { collection, record: record, userId: user.id });

    return c.json({ record: serializeRecord(record, collectionDef) });
  });

  // ── DELETE /:collection/:id — Delete record ───────────────────────
  app.delete('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user') as any;

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

    // Fetch existing for revision log, then delete atomically
    const existing = await (db as any)
      .selectFrom(tableName)
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!existing) return c.json({ error: 'Record not found' }, 404);

    const deleted = await dynamicDelete(db, tableName, id);
    if (!deleted) return c.json({ error: 'Record not found' }, 404);

    await db
      .insertInto('zv_revisions' as any)
      .values({
        collection,
        record_id: id,
        action: 'delete',
        data: JSON.stringify(existing),
        user_id: user.id,
      } as any)
      .execute()
      .catch(() => { /* non-fatal */ });

    await broadcastWebhook(db, 'delete', collection, { id });
    broadcastEvent(collection, 'delete', { id });
    sql`SELECT pg_notify('zveltio_changes', ${JSON.stringify({
      event: 'record.deleted',
      collection,
      record_id: id,
      timestamp: new Date().toISOString(),
    })})`.execute(db).catch(() => { /* non-fatal */ });

    // Extension event bus — synchronous, in-process
    engineEvents.emit('record.deleted', { collection, id, userId: user.id });

    return c.json({ success: true, id });
  });

  return app;
}
