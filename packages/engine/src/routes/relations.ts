import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { dynamicDropColumn } from '../db/dynamic.js';

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
  metadata: z.record(z.string(), z.any()).default({}),
});

/** Atomically add a field to collection.fields JSON. */
async function addFieldToCollection(
  db: Database,
  collectionName: string,
  field: { name: string; type: string; options?: Record<string, any> },
): Promise<void> {
  await (db as any).transaction().execute(async (trx: any) => {
    const locked = await (trx as any)
      .selectFrom('zvd_collections')
      .select(['fields'])
      .where('name', '=', collectionName)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) throw new Error(`Collection '${collectionName}' not found`);

    let current: any[];
    try {
      current = typeof locked.fields === 'string' ? JSON.parse(locked.fields) : (locked.fields ?? []);
    } catch {
      current = [];
    }

    if (current.some((f: any) => f.name === field.name)) return; // already present

    await (trx as any)
      .updateTable('zvd_collections')
      .set({ fields: JSON.stringify([...current, field]), updated_at: new Date() })
      .where('name', '=', collectionName)
      .execute();
  });
  DDLManager.invalidateCache(collectionName);
}

/** Atomically remove a field from collection.fields JSON. */
async function removeFieldFromCollection(
  db: Database,
  collectionName: string,
  fieldName: string,
): Promise<void> {
  await (db as any).transaction().execute(async (trx: any) => {
    const locked = await (trx as any)
      .selectFrom('zvd_collections')
      .select(['fields'])
      .where('name', '=', collectionName)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) return;

    let current: any[];
    try {
      current = typeof locked.fields === 'string' ? JSON.parse(locked.fields) : (locked.fields ?? []);
    } catch {
      current = [];
    }

    const updated = current.filter((f: any) => f.name !== fieldName);
    if (updated.length === current.length) return; // nothing to remove

    await (trx as any)
      .updateTable('zvd_collections')
      .set({ fields: JSON.stringify(updated), updated_at: new Date() })
      .where('name', '=', collectionName)
      .execute();
  });
  DDLManager.invalidateCache(collectionName);
}

export function relationsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

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
        ]),
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

  // POST / — Create relation (synchronous DDL + metadata update)
  app.post('/', zValidator('json', RelationSchema), async (c) => {
    const data = c.req.valid('json');

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
      .select(['id'])
      .where('source_collection', '=', data.source_collection)
      .where('source_field', '=', data.source_field)
      .executeTakeFirst();

    if (existing) {
      return c.json(
        { error: `A relation already exists on '${data.source_collection}.${data.source_field}'` },
        409,
      );
    }

    try {
      const sourceTable = DDLManager.getTableName(data.source_collection);
      const targetTable = DDLManager.getTableName(data.target_collection);
      let junctionTable: string | undefined;
      let resolvedTargetField = data.target_field ?? 'id';

      if (data.type === 'm2o') {
        // FK column in source table → target(id)
        await DDLManager.applyRelationFK(
          db,
          sourceTable,
          data.source_field,
          targetTable,
          data.on_delete,
          data.on_update,
        );
        await addFieldToCollection(db, data.source_collection, {
          name: data.source_field,
          type: 'm2o',
          options: { related_collection: data.target_collection },
        });
      } else if (data.type === 'o2m') {
        // FK column lives in TARGET table referencing source(id).
        // The form sends the FK column name via source_field (labeled "FK field in target").
        const fkInTarget = data.source_field || `${data.source_collection}_id`;
        resolvedTargetField = fkInTarget;
        await DDLManager.applyRelationFK(
          db,
          targetTable,
          fkInTarget,
          sourceTable,
          data.on_delete,
          data.on_update,
        );
        await addFieldToCollection(db, data.source_collection, {
          name: data.source_field,
          type: 'o2m',
          options: { related_collection: data.target_collection },
        });
      } else if (data.type === 'm2m') {
        junctionTable = await DDLManager.createJunctionTable(
          db,
          data.source_collection,
          data.target_collection,
        );
        await addFieldToCollection(db, data.source_collection, {
          name: data.source_field,
          type: 'm2m',
          options: { related_collection: data.target_collection },
        });
      }
      // m2a: virtual — no DDL needed, just metadata

      const relRow = await (db as any)
        .insertInto('zvd_relations')
        .values({
          name: data.name,
          type: data.type,
          source_collection: data.source_collection,
          source_field: data.source_field,
          target_collection: data.target_collection,
          target_field: resolvedTargetField,
          junction_table: junctionTable ?? data.junction_table ?? null,
          on_delete: data.on_delete,
          on_update: data.on_update,
          metadata: JSON.stringify(data.metadata),
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ relation: relRow }, 201);
    } catch (error: any) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Failed to create relation' },
        400,
      );
    }
  });

  // PATCH /:id — Update relation metadata only
  app.patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).optional(),
        on_delete: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).optional(),
        on_update: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).optional(),
        metadata: z.record(z.string(), z.any()).optional(),
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

  // DELETE /:id — Remove relation + DDL cleanup + metadata
  app.delete('/:id', async (c) => {
    const relation = await (db as any)
      .selectFrom('zvd_relations')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!relation) return c.json({ error: 'Relation not found' }, 404);

    try {
      const sourceTable = DDLManager.getTableName(relation.source_collection);
      const targetTable = DDLManager.getTableName(relation.target_collection);

      if (relation.type === 'm2o') {
        await dynamicDropColumn(db, sourceTable, relation.source_field);
        await removeFieldFromCollection(db, relation.source_collection, relation.source_field);
      } else if (relation.type === 'o2m') {
        const fkInTarget = relation.target_field || `${relation.source_collection}_id`;
        await dynamicDropColumn(db, targetTable, fkInTarget);
        await removeFieldFromCollection(db, relation.source_collection, relation.source_field);
      } else if (relation.type === 'm2m' && relation.junction_table) {
        await DDLManager.dropJunctionTable(db, relation.junction_table);
        await removeFieldFromCollection(db, relation.source_collection, relation.source_field);
      }
      // m2a: no DDL to undo

      await (db as any)
        .deleteFrom('zvd_relations')
        .where('id', '=', relation.id)
        .execute();

      return c.json({ success: true });
    } catch (error: any) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Failed to delete relation' },
        400,
      );
    }
  });

  return app;
}
