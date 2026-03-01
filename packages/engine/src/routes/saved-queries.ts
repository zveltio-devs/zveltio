/**
 * Saved Queries — Query Builder + Persistence
 *
 * POST   /api/saved-queries           — save a query config
 * GET    /api/saved-queries           — list user's queries (+ shared)
 * GET    /api/saved-queries/:id       — get single saved query
 * PUT    /api/saved-queries/:id       — update query
 * DELETE /api/saved-queries/:id       — delete query
 * POST   /api/saved-queries/:id/run   — execute saved query
 * POST   /api/saved-queries/execute   — execute query config without saving
 * POST   /api/saved-queries/preview-url — generate API URL preview
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';
import { DDLManager } from '../lib/ddl-manager.js';

// ── Zod schemas ───────────────────────────────────────────────────────────────

const QueryConfigSchema = z.object({
  filters: z.array(z.object({
    field: z.string(),
    operator: z.string(),
    value: z.any().optional(),
    group: z.string().optional(),
  })).optional().default([]),
  filter_mode: z.enum(['AND', 'OR']).optional().default('AND'),
  filter_groups: z.array(z.object({
    id: z.string(),
    mode: z.enum(['AND', 'OR']),
  })).optional().default([]),
  columns: z.array(z.string()).optional().default([]),
  sorts: z.array(z.object({
    field: z.string(),
    direction: z.enum(['asc', 'desc']).optional().default('asc'),
  })).optional().default([]),
  limit: z.number().min(1).max(1000).optional().default(50),
  page: z.number().min(1).optional().default(1),
});

const SaveQuerySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  collection: z.string().min(1),
  config: QueryConfigSchema,
  is_shared: z.boolean().optional().default(false),
});

const UpdateQuerySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  config: QueryConfigSchema.optional(),
  is_shared: z.boolean().optional(),
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueryConfig {
  filters: Array<{ field: string; operator: string; value?: any; group?: string }>;
  filter_mode: 'AND' | 'OR';
  filter_groups: Array<{ id: string; mode: 'AND' | 'OR' }>;
  columns: string[];
  sorts: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit: number;
  page: number;
}

// ── Filter helpers ─────────────────────────────────────────────────────────────

function applyFilter(query: any, filter: { field: string; operator: string; value?: any }): any {
  const { field, operator, value } = filter;
  switch (operator) {
    case 'equals':       return query.where(field, '=', value);
    case 'not_equals':   return query.where(field, '!=', value);
    case 'contains':     return query.where(field, 'like', `%${value}%`);
    case 'not_contains': return query.where(field, 'not like', `%${value}%`);
    case 'starts_with':  return query.where(field, 'like', `${value}%`);
    case 'ends_with':    return query.where(field, 'like', `%${value}`);
    case 'gt':           return query.where(field, '>', value);
    case 'lt':           return query.where(field, '<', value);
    case 'gte':          return query.where(field, '>=', value);
    case 'lte':          return query.where(field, '<=', value);
    case 'between':
      if (Array.isArray(value) && value.length === 2) return query.where(field, 'between', [value[0], value[1]]);
      return query;
    case 'is_empty': case 'is_null':         return query.where(field, 'is', null);
    case 'is_not_empty': case 'is_not_null': return query.where(field, 'is not', null);
    case 'is_true':  return query.where(field, '=', true);
    case 'is_false': return query.where(field, '=', false);
    case 'in':  return Array.isArray(value) ? query.where(field, 'in', value) : query;
    case 'not_in': return Array.isArray(value) ? query.where(field, 'not in', value) : query;
    default: return query;
  }
}

function buildFilterCondition(eb: any, filter: { field: string; operator: string; value?: any }): any {
  const { field, operator, value } = filter;
  switch (operator) {
    case 'equals':       return eb(field, '=', value);
    case 'not_equals':   return eb(field, '!=', value);
    case 'contains':     return eb(field, 'like', `%${value}%`);
    case 'not_contains': return eb(field, 'not like', `%${value}%`);
    case 'starts_with':  return eb(field, 'like', `${value}%`);
    case 'ends_with':    return eb(field, 'like', `%${value}`);
    case 'gt':  return eb(field, '>', value);
    case 'lt':  return eb(field, '<', value);
    case 'gte': return eb(field, '>=', value);
    case 'lte': return eb(field, '<=', value);
    case 'between':
      if (Array.isArray(value) && value.length === 2) return eb.and([eb(field, '>=', value[0]), eb(field, '<=', value[1])]);
      return eb(field, '=', field);
    case 'is_empty': case 'is_null':         return eb(field, 'is', null);
    case 'is_not_empty': case 'is_not_null': return eb(field, 'is not', null);
    case 'is_true':  return eb(field, '=', true);
    case 'is_false': return eb(field, '=', false);
    case 'in':     return Array.isArray(value) ? eb(field, 'in', value) : eb(field, '=', field);
    case 'not_in': return Array.isArray(value) ? eb(field, 'not in', value) : eb(field, '=', field);
    default: return eb(field, '=', value);
  }
}

function generateApiUrl(collection: string, config: QueryConfig): string {
  const params = new URLSearchParams();
  for (const filter of (config.filters || [])) {
    if (filter.group) continue;
    switch (filter.operator) {
      case 'equals':     params.append(`filter[${filter.field}]`, String(filter.value)); break;
      case 'not_equals': params.append(`filter[${filter.field}][ne]`, String(filter.value)); break;
      case 'contains':   params.append(`filter[${filter.field}][like]`, `%${filter.value}%`); break;
      case 'gt': params.append(`filter[${filter.field}][gt]`, String(filter.value)); break;
      case 'lt': params.append(`filter[${filter.field}][lt]`, String(filter.value)); break;
      case 'gte': params.append(`filter[${filter.field}][gte]`, String(filter.value)); break;
      case 'lte': params.append(`filter[${filter.field}][lte]`, String(filter.value)); break;
      case 'is_null': params.append(`filter[${filter.field}][is]`, 'null'); break;
      case 'is_not_null': params.append(`filter[${filter.field}][not]`, 'null'); break;
    }
  }
  if (config.sorts?.length) {
    params.append('sort', config.sorts.map((s) => s.direction === 'desc' ? `-${s.field}` : s.field).join(','));
  }
  params.append('limit', String(config.limit || 50));
  if (config.page && config.page > 1) params.append('page', String(config.page));
  const qs = params.toString();
  return `GET /api/data/${collection}${qs ? '?' + qs : ''}`;
}

// ── Query executor ────────────────────────────────────────────────────────────

async function executeQueryConfig(
  db: Database,
  collection: string,
  config: QueryConfig,
  userId: string,
): Promise<{ records: any[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const tableName = DDLManager.getTableName(collection);
  const exists = await DDLManager.tableExists(db, collection);
  if (!exists) throw new Error('Collection not found');

  const isSystem = tableName.startsWith('zv_') && !tableName.startsWith('zvd_');
  if (isSystem) {
    const hasAdmin = await checkPermission(userId, 'admin', 'read');
    if (!hasAdmin) throw new Error('System tables require admin access');
  }

  const offset = (config.page - 1) * config.limit;
  let baseQuery: any = (db as any).selectFrom(tableName);

  if (config.columns?.length > 0) {
    const selectFields = config.columns.includes('id') ? config.columns : ['id', ...config.columns];
    baseQuery = baseQuery.select(selectFields);
  } else {
    baseQuery = baseQuery.selectAll();
  }

  if (config.filters?.length > 0) {
    const filtersByGroup: Record<string, typeof config.filters> = {};
    const ungrouped: typeof config.filters = [];
    for (const filter of config.filters) {
      if (filter.group) {
        if (!filtersByGroup[filter.group]) filtersByGroup[filter.group] = [];
        filtersByGroup[filter.group].push(filter);
      } else {
        ungrouped.push(filter);
      }
    }

    if (ungrouped.length > 0) {
      if (config.filter_mode === 'AND') {
        for (const f of ungrouped) baseQuery = applyFilter(baseQuery, f);
      } else {
        baseQuery = baseQuery.where((eb: any) => eb.or(ungrouped.map((f) => buildFilterCondition(eb, f))));
      }
    }

    for (const [groupId, groupFilters] of Object.entries(filtersByGroup)) {
      const groupConfig = config.filter_groups?.find((g) => g.id === groupId);
      const groupMode = groupConfig?.mode || 'AND';
      baseQuery = baseQuery.where((eb: any) => {
        const conditions = groupFilters.map((f) => buildFilterCondition(eb, f));
        return groupMode === 'AND' ? eb.and(conditions) : eb.or(conditions);
      });
    }
  }

  const countResult = await baseQuery
    .clearSelect()
    .select((eb: any) => eb.fn.countAll().as('count'))
    .execute();
  const total = parseInt(countResult[0]?.count || '0');

  if (config.sorts?.length > 0) {
    for (const sort of config.sorts) baseQuery = baseQuery.orderBy(sort.field, sort.direction || 'asc');
  } else {
    baseQuery = baseQuery.orderBy('created_at', 'desc');
  }

  const records = await baseQuery.limit(config.limit).offset(offset).execute();
  return {
    records,
    pagination: { page: config.page, limit: config.limit, total, totalPages: Math.ceil(total / config.limit) },
  };
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function savedQueriesRoutes(db: Database, _auth: any): Hono {
  const app = new Hono<{ Variables: { user: any } }>();

  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    return next();
  });

  // POST /execute — execute without saving (before /:id routes)
  app.post('/execute', zValidator('json', z.object({ collection: z.string(), config: QueryConfigSchema })), async (c) => {
    const user = c.get('user');
    const data = c.req.valid('json');

    try {
      const exists = await DDLManager.tableExists(db, data.collection);
      if (!exists) return c.json({ error: 'Collection not found' }, 404);

      const tableName = DDLManager.getTableName(data.collection);
      const isSystem = tableName.startsWith('zv_') && !tableName.startsWith('zvd_');
      if (isSystem) {
        const hasAdmin = await checkPermission(user.id, 'admin', '*');
        if (!hasAdmin) return c.json({ error: 'Query Builder only works on user-defined collections' }, 403);
      }

      const config: QueryConfig = {
        filters: data.config.filters,
        filter_mode: data.config.filter_mode,
        filter_groups: data.config.filter_groups,
        columns: data.config.columns,
        sorts: data.config.sorts,
        limit: data.config.limit,
        page: data.config.page,
      };

      const result = await executeQueryConfig(db, data.collection, config, user.id);
      const apiUrl = generateApiUrl(data.collection, config);
      return c.json({ collection: data.collection, api_url: apiUrl, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to execute query' }, 500);
    }
  });

  // POST /preview-url
  app.post('/preview-url', zValidator('json', z.object({ collection: z.string(), config: QueryConfigSchema })), async (c) => {
    const data = c.req.valid('json');
    const config: QueryConfig = {
      filters: data.config.filters,
      filter_mode: data.config.filter_mode,
      filter_groups: data.config.filter_groups,
      columns: data.config.columns,
      sorts: data.config.sorts,
      limit: data.config.limit,
      page: data.config.page,
    };
    return c.json({ api_url: generateApiUrl(data.collection, config) });
  });

  // POST / — save query
  app.post('/', zValidator('json', SaveQuerySchema), async (c) => {
    const user = c.get('user');
    const data = c.req.valid('json');

    try {
      const exists = await DDLManager.tableExists(db, data.collection);
      if (!exists) return c.json({ error: 'Collection not found' }, 404);

      let isShared = data.is_shared;
      if (isShared) {
        const hasAdmin = await checkPermission(user.id, 'admin', '*');
        if (!hasAdmin) isShared = false;
      }

      const result = await sql<{ id: string }>`
        INSERT INTO zv_saved_queries (name, description, collection, config, is_shared, created_by)
        VALUES (${data.name}, ${data.description || null}, ${data.collection}, ${JSON.stringify(data.config)}::jsonb, ${isShared}, ${user.id})
        RETURNING id
      `.execute(db);

      return c.json({ id: result.rows[0].id, success: true }, 201);
    } catch (err) {
      return c.json({ error: 'Failed to save query' }, 500);
    }
  });

  // GET / — list queries
  app.get('/', async (c) => {
    const user = c.get('user');
    const collection = c.req.query('collection');

    try {
      let whereClause = `WHERE created_by = '${user.id}' OR is_shared = true`;
      if (collection) whereClause += ` AND collection = '${collection}'`;

      const result = await sql<any>`
        SELECT id, name, description, collection, config, is_shared, created_by, created_at, updated_at
        FROM zv_saved_queries
        ${sql.raw(whereClause)}
        ORDER BY created_at DESC
      `.execute(db);

      const ownedIds = new Set(result.rows.filter((r) => r.created_by === user.id).map((r) => r.id));
      const queries = result.rows.map((q) => ({ ...q, is_owner: ownedIds.has(q.id) }));
      return c.json({ queries });
    } catch (err) {
      return c.json({ error: 'Failed to fetch saved queries' }, 500);
    }
  });

  // GET /:id
  app.get('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    try {
      const result = await sql<any>`
        SELECT id, name, description, collection, config, is_shared, created_by, created_at, updated_at
        FROM zv_saved_queries
        WHERE id = ${id} AND (created_by = ${user.id} OR is_shared = true)
      `.execute(db);

      if (result.rows.length === 0) return c.json({ error: 'Query not found' }, 404);
      const q = result.rows[0];
      return c.json({ ...q, is_owner: q.created_by === user.id });
    } catch (err) {
      return c.json({ error: 'Failed to fetch saved query' }, 500);
    }
  });

  // PUT /:id
  app.put('/:id', zValidator('json', UpdateQuerySchema), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const data = c.req.valid('json');

    try {
      const existing = await sql<{ created_by: string }>`
        SELECT created_by FROM zv_saved_queries WHERE id = ${id}
      `.execute(db);

      if (existing.rows.length === 0) return c.json({ error: 'Query not found' }, 404);
      if (existing.rows[0].created_by !== user.id) return c.json({ error: 'You can only edit your own queries' }, 403);

      if (data.is_shared) {
        const hasAdmin = await checkPermission(user.id, 'admin', '*');
        if (!hasAdmin) return c.json({ error: 'Only admins can make queries shared' }, 403);
      }

      const updates: Record<string, any> = { updated_at: new Date() };
      if (data.name !== undefined) updates.name = data.name;
      if (data.description !== undefined) updates.description = data.description;
      if (data.config !== undefined) updates.config = JSON.stringify(data.config) as any;
      if (data.is_shared !== undefined) updates.is_shared = data.is_shared;

      await (db as any).updateTable('zv_saved_queries').set(updates).where('id', '=', id).execute();
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: 'Failed to update saved query' }, 500);
    }
  });

  // DELETE /:id
  app.delete('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    try {
      const existing = await sql<{ created_by: string }>`
        SELECT created_by FROM zv_saved_queries WHERE id = ${id}
      `.execute(db);

      if (existing.rows.length === 0) return c.json({ error: 'Query not found' }, 404);

      const hasAdmin = await checkPermission(user.id, 'admin', '*');
      if (existing.rows[0].created_by !== user.id && !hasAdmin) {
        return c.json({ error: 'You can only delete your own queries' }, 403);
      }

      await sql`DELETE FROM zv_saved_queries WHERE id = ${id}`.execute(db);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: 'Failed to delete saved query' }, 500);
    }
  });

  // POST /:id/run
  app.post('/:id/run', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    try {
      const result = await sql<any>`
        SELECT collection, config, is_shared, created_by
        FROM zv_saved_queries
        WHERE id = ${id} AND (created_by = ${user.id} OR is_shared = true)
      `.execute(db);

      if (result.rows.length === 0) return c.json({ error: 'Query not found' }, 404);
      const saved = result.rows[0];

      const override = await c.req.json().catch(() => ({})) as { page?: number; limit?: number };
      const config: QueryConfig = {
        ...saved.config,
        page: override.page || saved.config.page || 1,
        limit: override.limit || saved.config.limit || 50,
      };

      const queryResult = await executeQueryConfig(db, saved.collection, config, user.id);
      return c.json({ collection: saved.collection, ...queryResult });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to run query' }, 500);
    }
  });

  return app;
}
