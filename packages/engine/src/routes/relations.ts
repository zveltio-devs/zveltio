import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
// requireInstanceAdmin, not checkPermission(uid,'admin','*'): schema DDL — foreign keys and junction tables are shared structure, not tenant data.
// The tenant_admin policy is ('*','*','*'), so the weak gate matched obj='admin'
// and admitted any delegated tenant admin.
import { requireInstanceAdmin } from '../lib/tenancy/index.js';
import {
  createRelation,
  DDLManager,
  FieldChangeError,
  fieldsChanged,
  RelationSchema,
  removeFieldFromCollection,
} from '../lib/data/index.js';
import { dynamicDropColumn } from '../db/dynamic.js';
import { toJsonb } from '../lib/jsonb.js';
import { guardAdmin } from '../lib/admin-guard.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function relationsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const user = await guardAdmin(c, auth, requireInstanceAdmin);
    if (user instanceof Response) return user;
    c.set('user', user);
    await next();
  });

  /** Normalize a relation row before returning it to clients: metadata may
   *  have been stored as a JSON-encoded string by older code paths, but the
   *  API contract is "metadata is always an object". */

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  function normalize(rel: any): any {
    if (!rel) return rel;
    if (typeof rel.metadata === 'string') {
      try {
        rel.metadata = JSON.parse(rel.metadata);
      } catch {
        rel.metadata = {};
      }
    } else if (rel.metadata == null) {
      rel.metadata = {};
    }
    return rel;
  }

  // GET / — List all relations, optionally filtered by collection
  app.get('/', async (c) => {
    const { collection } = c.req.query();

    let query = db.selectFrom('zvd_relations').selectAll().orderBy('created_at', 'desc');

    if (collection) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      query = query.where((eb: any) =>
        eb.or([eb('source_collection', '=', collection), eb('target_collection', '=', collection)]),
      );
    }

    const relations = await query.execute();
    return c.json({ relations: relations.map(normalize) });
  });

  // GET /:id — Get single relation
  app.get('/:id', async (c) => {
    const relation = await db
      .selectFrom('zvd_relations')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!relation) return c.json({ error: 'Relation not found' }, 404);
    return c.json({ relation: normalize(relation) });
  });

  // POST / — Create relation (synchronous DDL + metadata update)
  app.post('/', zValidator('json', RelationSchema), async (c) => {
    try {
      const relation = await createRelation(db, c.req.valid('json'));
      return c.json({ relation: normalize(relation) }, 201);
    } catch (error) {
      if (error instanceof FieldChangeError) return c.json({ error: error.message }, error.status);
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

      const existing = await db
        .selectFrom('zvd_relations')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) return c.json({ error: 'Relation not found' }, 404);

      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const toUpdate: Record<string, any> = { updated_at: new Date() };
      if (updates.name !== undefined) toUpdate.name = updates.name;
      if (updates.on_delete !== undefined) toUpdate.on_delete = updates.on_delete;
      if (updates.on_update !== undefined) toUpdate.on_update = updates.on_update;
      if (updates.metadata !== undefined) toUpdate.metadata = updates.metadata;

      const relation = await db
        .updateTable('zvd_relations')
        .set(toUpdate)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();

      return c.json({ relation: normalize(relation) });
    },
  );

  // DELETE /:id — Remove relation + DDL cleanup + metadata
  app.delete('/:id', async (c) => {
    const relation = await db
      .selectFrom('zvd_relations')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!relation) return c.json({ error: 'Relation not found' }, 404);

    try {
      const sourceTable = DDLManager.getTableName(relation.source_collection);
      const targetTable = DDLManager.getTableName(relation.target_collection);

      // DROP, fields and relation row in one transaction (all transactional DDL):
      // separately, a failure left a relation row naming a column already gone.
      await db.transaction().execute(async (trx) => {
        // The field before its column: its row rule's policy names the column.
        if (relation.type === 'm2o') {
          await removeFieldFromCollection(trx, relation.source_collection, relation.source_field);
          await dynamicDropColumn(trx, sourceTable, relation.source_field);
        } else if (relation.type === 'o2m') {
          const fkInTarget = relation.target_field || `${relation.source_collection}_id`;
          await removeFieldFromCollection(trx, relation.source_collection, relation.source_field);
          await removeFieldFromCollection(trx, relation.target_collection, fkInTarget);
          await dynamicDropColumn(trx, targetTable, fkInTarget);
        } else if (relation.type === 'm2m' && relation.junction_table) {
          await removeFieldFromCollection(trx, relation.source_collection, relation.source_field);
          await DDLManager.dropJunctionTable(trx, relation.junction_table);
        }
        // m2a: no DDL to undo

        await trx.deleteFrom('zvd_relations').where('id', '=', relation.id).execute();
      });
      fieldsChanged(relation.source_collection, relation.target_collection);
      for (const c of new Set([relation.source_collection, relation.target_collection])) {
        await DDLManager.forgetFieldRules(c);
      }

      return c.json({ success: true });
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    } catch (error: any) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Failed to delete relation' },
        400,
      );
    }
  });

  return app;
}
