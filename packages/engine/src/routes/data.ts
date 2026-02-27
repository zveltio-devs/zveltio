import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { fieldTypeRegistry } from '../lib/field-type-registry.js';
import { checkPermission } from '../lib/permissions.js';
import {
  dynamicSelect,
  dynamicInsert,
  dynamicUpdate,
  dynamicDelete,
  type FilterCondition,
} from '../db/dynamic.js';

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

// Simple SHA-256 hash for API key validation
async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
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

  // Update last_used_at
  await db
    .updateTable('zv_api_keys' as any)
    .set({ last_used_at: new Date() } as any)
    .where('id' as any, '=', (apiKey as any).id)
    .execute();

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
async function broadcastWebhook(db: Database, event: string, collection: string, data: any): Promise<void> {
  try {
    const webhooks = await db
      .selectFrom('zvd_webhooks' as any)
      .selectAll()
      .where('active' as any, '=', true)
      .execute();

    for (const wh of webhooks as any[]) {
      const events: string[] = wh.events || [];
      const collections: string[] = wh.collections || [];

      if (!events.includes(event) && !events.includes('*')) continue;
      if (collections.length > 0 && !collections.includes(collection) && !collections.includes('*')) continue;

      // Fire and forget webhook delivery
      fetch(wh.url, {
        method: wh.method || 'POST',
        headers: { 'Content-Type': 'application/json', ...((wh.headers as object) || {}) },
        body: JSON.stringify({ event, collection, data, timestamp: new Date().toISOString() }),
        signal: AbortSignal.timeout(wh.timeout || 5000),
      }).catch(() => { /* webhook failures are non-fatal */ });
    }
  } catch { /* non-fatal */ }
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

    if (!(await DDLManager.tableExists(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const tableName = DDLManager.getTableName(collection);
    const collectionDef = await DDLManager.getCollection(db, collection);
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

    // Full-text search: add as safe parameterized condition via dynamic helper
    // search_vector is a standard tsvector column; query terms are passed as $1 parameter
    if (query.search) {
      // Parameterized via Kysely sql tag — no string interpolation into SQL
      const searchTerms = query.search.trim().split(/\s+/).filter(Boolean).join(' & ');
      filters['_fts'] = { op: 'eq', value: searchTerms }; // placeholder — handled below
    }

    const result = await dynamicSelect(db, tableName, {
      filters: query.search
        ? Object.fromEntries(Object.entries(filters).filter(([k]) => k !== '_fts'))
        : filters,
      sort: query.sort ? { field: query.sort, direction: query.order } : undefined,
      limit: query.limit,
      offset,
    });

    // Apply full-text search as an additional WHERE on top (uses parameterized query)
    let records = result.records;
    if (query.search && result.records.length > 0) {
      const searchTerms = query.search.trim().split(/\s+/).filter(Boolean).join(' & ');
      const ftsResult = await sql`
        SELECT * FROM ${sql.identifier(tableName)}
        WHERE search_vector @@ to_tsquery('english', ${searchTerms})
        ORDER BY created_at DESC
        LIMIT ${query.limit} OFFSET ${offset}
      `.execute(db).catch(() => ({ rows: result.records }));
      records = ftsResult.rows as Record<string, any>[];
    }

    const serialized = records.map((r) => serializeRecord(r, collectionDef));

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

    if (!(await checkAccess(db, user, collection, 'read'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (!(await DDLManager.tableExists(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const tableName = DDLManager.getTableName(collection);
    const collectionDef = await DDLManager.getCollection(db, collection);

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

    if (!(await DDLManager.tableExists(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const tableName = DDLManager.getTableName(collection);
    const collectionDef = await DDLManager.getCollection(db, collection);
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

    await broadcastWebhook(db, 'insert', collection, record);

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

    if (!(await DDLManager.tableExists(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const tableName = DDLManager.getTableName(collection);
    const collectionDef = await DDLManager.getCollection(db, collection);
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

    await broadcastWebhook(db, 'update', collection, record);

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

    if (!(await DDLManager.tableExists(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const tableName = DDLManager.getTableName(collection);
    const collectionDef = await DDLManager.getCollection(db, collection);
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

    await broadcastWebhook(db, 'update', collection, record);

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

    if (!(await DDLManager.tableExists(db, collection))) {
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

    return c.json({ success: true, id });
  });

  return app;
}
