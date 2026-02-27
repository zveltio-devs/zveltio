import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { enqueueDDLJob } from '../lib/ddl-queue.js';
import { DDLManager } from '../lib/ddl-manager.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

const RelationSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(['m2o', 'o2m', 'm2m', 'm2a']),
  source_collection: z.string().min(1),
  source_field: z.string().min(1),
  target_collection: z.string().min(1),
  target_field: z.string().optional(),
  junction_table: z.string().optional(),
  on_delete: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).default('SET NULL'),
  on_update: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).default('CASCADE'),
  metadata: z.record(z.any()).default({}),
});

export function relationsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Admin auth middleware
  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET / — List all relations, optionally filtered by collection
  app.get('/', async (c) => {
    const { collection } = c.req.query();

    let query = (db as any)
      .selectFrom('zvd_relations')
      .selectAll()
      .orderBy('created_at', 'desc');

    if (collection) {
      query = query.where((eb: any) =>
        eb.or([
          eb('source_collection', '=', collection),
          eb('target_collection', '=', collection),
        ])
      );
    }

    const relations = await query.execute();
    return c.json({ relations });
  });

  // GET /:id — Get single relation
  app.get('/:id', async (c) => {
    const relation = await (db as any)
      .selectFrom('zvd_relations')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!relation) return c.json({ error: 'Relation not found' }, 404);
    return c.json({ relation });
  });

  // POST / — Create relation (async DDL job)
  app.post('/', zValidator('json', RelationSchema), async (c) => {
    const data = c.req.valid('json');

    // Validate that collections exist
    const [sourceExists, targetExists] = await Promise.all([
      DDLManager.tableExists(db, data.source_collection),
      DDLManager.tableExists(db, data.target_collection),
    ]);

    if (!sourceExists) {
      return c.json({ error: `Source collection '${data.source_collection}' not found` }, 404);
    }
    if (!targetExists) {
      return c.json({ error: `Target collection '${data.target_collection}' not found` }, 404);
    }

    // Check for duplicate
    const existing = await (db as any)
      .selectFrom('zvd_relations')
      .selectAll()
      .where('source_collection', '=', data.source_collection)
      .where('source_field', '=', data.source_field)
      .executeTakeFirst();

    if (existing) {
      return c.json({ error: `A relation already exists on '${data.source_collection}.${data.source_field}'` }, 409);
    }

    // Store relation metadata first
    const relation = await (db as any)
      .insertInto('zvd_relations')
      .values({
        ...data,
        metadata: JSON.stringify(data.metadata),
      })
      .returningAll()
      .executeTakeFirst();

    // Enqueue DDL job to apply the FK constraint
    const jobId = await enqueueDDLJob(db, 'create_relation', {
      relation_id: relation.id,
      ...data,
    });

    return c.json({ relation, job_id: jobId }, 202);
  });

  // PATCH /:id — Update relation metadata
  app.patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).optional(),
        on_delete: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).optional(),
        on_update: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).optional(),
        metadata: z.record(z.any()).optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param('id');
      const updates = c.req.valid('json');

      const existing = await (db as any)
        .selectFrom('zvd_relations')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) return c.json({ error: 'Relation not found' }, 404);

      const toUpdate: Record<string, any> = { updated_at: new Date() };
      if (updates.name !== undefined) toUpdate.name = updates.name;
      if (updates.on_delete !== undefined) toUpdate.on_delete = updates.on_delete;
      if (updates.on_update !== undefined) toUpdate.on_update = updates.on_update;
      if (updates.metadata !== undefined) toUpdate.metadata = JSON.stringify(updates.metadata);

      const relation = await (db as any)
        .updateTable('zvd_relations')
        .set(toUpdate)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();

      return c.json({ relation });
    },
  );

  // DELETE /:id — Remove relation
  app.delete('/:id', async (c) => {
    const relation = await (db as any)
      .selectFrom('zvd_relations')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!relation) return c.json({ error: 'Relation not found' }, 404);

    // Enqueue DDL job to drop FK constraint
    const jobId = await enqueueDDLJob(db, 'drop_relation', {
      relation_id: relation.id,
      source_collection: relation.source_collection,
      source_field: relation.source_field,
      junction_table: relation.junction_table,
      type: relation.type,
    });

    // Remove from registry immediately
    await (db as any)
      .deleteFrom('zvd_relations')
      .where('id', '=', relation.id)
      .execute();

    return c.json({ success: true, job_id: jobId });
  });

  return app;
}
