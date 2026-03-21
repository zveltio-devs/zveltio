import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../../../packages/engine/src/db/index.js';
import { checkPermission } from '../../../packages/engine/src/lib/permissions.js';
import { SearchManager } from './lib/search-manager.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

export function searchRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  SearchManager.init(db);

  // All routes require admin
  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET /search — search via configured provider
  app.get('/search', async (c) => {
    const { q = '', collection, limit = '20', filters } = c.req.query();

    if (!collection) return c.json({ error: 'collection query param is required' }, 400);
    if (!q.trim()) return c.json({ results: [], hits: [] });

    try {
      const results = await SearchManager.search(collection, q, {
        limit: Math.min(parseInt(limit) || 20, 100),
        filters: filters || undefined,
      });
      return c.json({ results });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // GET /indexes — list configured search indexes
  app.get('/indexes', async (c) => {
    const indexes = await (db as any)
      .selectFrom('zv_search_indexes')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return c.json({ indexes });
  });

  // POST /indexes — create/configure index for a collection
  app.post(
    '/indexes',
    zValidator(
      'json',
      z.object({
        collection: z.string().min(1),
        provider: z.enum(['meilisearch', 'typesense']).default('meilisearch'),
        index_name: z.string().min(1),
        searchable_fields: z.array(z.string()).default([]),
        filterable_fields: z.array(z.string()).default([]),
        sortable_fields: z.array(z.string()).default([]),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');

      // Upsert: update if exists, insert if not
      const existing = await (db as any)
        .selectFrom('zv_search_indexes')
        .select('id')
        .where('collection', '=', data.collection)
        .executeTakeFirst();

      let indexRecord: any;
      if (existing) {
        indexRecord = await (db as any)
          .updateTable('zv_search_indexes')
          .set({
            provider: data.provider,
            index_name: data.index_name,
            searchable_fields: data.searchable_fields,
            filterable_fields: data.filterable_fields,
            sortable_fields: data.sortable_fields,
            status: 'active',
          })
          .where('collection', '=', data.collection)
          .returningAll()
          .executeTakeFirst();
      } else {
        indexRecord = await (db as any)
          .insertInto('zv_search_indexes')
          .values({
            collection: data.collection,
            provider: data.provider,
            index_name: data.index_name,
            searchable_fields: data.searchable_fields,
            filterable_fields: data.filterable_fields,
            sortable_fields: data.sortable_fields,
          })
          .returningAll()
          .executeTakeFirst();
      }

      return c.json({ index: indexRecord }, existing ? 200 : 201);
    },
  );

  // DELETE /indexes/:collection — remove index config
  app.delete('/indexes/:collection', async (c) => {
    const collection = c.req.param('collection');
    await (db as any)
      .updateTable('zv_search_indexes')
      .set({ status: 'inactive' })
      .where('collection', '=', collection)
      .execute();
    return c.json({ success: true });
  });

  // POST /indexes/:collection/sync — trigger full re-sync (background)
  app.post('/indexes/:collection/sync', async (c) => {
    const collection = c.req.param('collection');

    // Run sync in background
    SearchManager.sync(collection).catch((err) => {
      console.error(`[SearchRoutes] Sync failed for ${collection}:`, err);
    });

    return c.json({ message: 'Sync started in background', collection });
  });

  // GET /indexes/:collection/stats — record count, last synced, status
  app.get('/indexes/:collection/stats', async (c) => {
    const collection = c.req.param('collection');
    const index = await (db as any)
      .selectFrom('zv_search_indexes')
      .selectAll()
      .where('collection', '=', collection)
      .executeTakeFirst();

    if (!index) return c.json({ error: 'Index not found' }, 404);

    return c.json({
      collection: index.collection,
      provider: index.provider,
      index_name: index.index_name,
      status: index.status,
      record_count: index.record_count ?? 0,
      last_synced_at: index.last_synced_at,
    });
  });

  return app;
}
