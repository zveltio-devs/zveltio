import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
// requireInstanceAdmin, not checkPermission(uid,'admin','*'): schema DDL — foreign keys and junction tables are shared structure, not tenant data.
// The tenant_admin policy is ('*','*','*'), so the weak gate matched obj='admin'
// and admitted any delegated tenant admin.
import { requireInstanceAdmin } from '../lib/tenancy/index.js';
import { announceSchemaChange, DDLManager } from '../lib/data/index.js';
import { dynamicDropColumn } from '../db/dynamic.js';
import { toJsonb } from '../lib/jsonb.js';
import { guardAdmin } from '../lib/admin-guard.js';

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

const RelationSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(['m2o', 'o2m', 'm2m', 'm2a']),
  source_collection: z.string().min(1),
  /** For m2o: FK column name in the SOURCE table.
   *  For o2m: virtual alias on the SOURCE collection (e.g. "orders"); the
   *           physical FK column lives in the target table — see target_field.
   *  For m2m: virtual alias on the SOURCE collection.                       */
  source_field: z.string().regex(SAFE_IDENTIFIER, 'must be lowercase snake_case'),
  target_collection: z.string().min(1),
  /** For o2m: REQUIRED. FK column name in the TARGET table (e.g. "customer_id").
   *  For m2o: ignored (always 'id').
   *  For m2m: ignored.                                                      */
  target_field: z.string().regex(SAFE_IDENTIFIER).optional(),
  junction_table: z.string().optional(),
  on_delete: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).default('SET NULL'),
  on_update: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).default('CASCADE'),
  metadata: z.record(z.string(), z.any()).default({}),
});

// The field helpers run on the CALLER's transaction, so a collection's fields and
// the `zvd_relations` row describing them commit or roll back together. Each on
// its own transaction, a failure between them left one without the other.

/** Add a field to collection.fields JSON (row-locked). */
async function addFieldToCollection(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  trx: any,
  collectionName: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  field: { name: string; type: string; options?: Record<string, any> },
): Promise<void> {
  const locked = await trx
    .selectFrom('zvd_collections')
    .select(['fields'])
    .where('name', '=', collectionName)
    .forUpdate()
    .executeTakeFirst();
  if (!locked) throw new Error(`Collection '${collectionName}' not found`);

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  let current: any[];
  try {
    current = typeof locked.fields === 'string' ? JSON.parse(locked.fields) : (locked.fields ?? []);
  } catch {
    current = [];
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  if (current.some((f: any) => f.name === field.name)) return; // already present

  await trx
    .updateTable('zvd_collections')
    .set({ fields: toJsonb([...current, field]), updated_at: new Date() })
    .where('name', '=', collectionName)
    .execute();
}

/** Remove a field from collection.fields JSON (row-locked). */
async function removeFieldFromCollection(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  trx: any,
  collectionName: string,
  fieldName: string,
): Promise<void> {
  const locked = await trx
    .selectFrom('zvd_collections')
    .select(['fields'])
    .where('name', '=', collectionName)
    .forUpdate()
    .executeTakeFirst();
  if (!locked) return;

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  let current: any[];
  try {
    current = typeof locked.fields === 'string' ? JSON.parse(locked.fields) : (locked.fields ?? []);
  } catch {
    current = [];
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const updated = current.filter((f: any) => f.name !== fieldName);
  if (updated.length === current.length) return; // nothing to remove

  await trx
    .updateTable('zvd_collections')
    .set({ fields: toJsonb(updated), updated_at: new Date() })
    .where('name', '=', collectionName)
    .execute();
}

/** After the commit, not inside it — a reader in between would re-cache the old row. */
function fieldsChanged(...collections: string[]): void {
  for (const name of new Set(collections)) {
    DDLManager.invalidateCache(name);
    announceSchemaChange(name, 'alter');
  }
}

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
    const existing = await db
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
      const fieldsToAdd: Array<[string, Parameters<typeof addFieldToCollection>[2]]> = [];

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
        fieldsToAdd.push([
          data.source_collection,
          {
            name: data.source_field,
            type: 'm2o',
            options: { related_collection: data.target_collection },
          },
        ]);
      } else if (data.type === 'o2m') {
        // FK column lives in TARGET table referencing source(id).
        // source_field = virtual alias on source ("orders").
        // target_field = physical FK column in target ("customer_id").
        // If target_field is omitted, default to "<source_collection>_id".
        const fkInTarget = data.target_field || `${data.source_collection}_id`;
        if (!SAFE_IDENTIFIER.test(fkInTarget)) {
          throw new Error(`Invalid FK column name: "${fkInTarget}"`);
        }
        if (fkInTarget === data.source_field) {
          throw new Error(
            `target_field ("${fkInTarget}") cannot equal source_field ("${data.source_field}"). ` +
              `source_field is the virtual alias on "${data.source_collection}"; ` +
              `target_field is the physical FK column in "${data.target_collection}".`,
          );
        }
        resolvedTargetField = fkInTarget;
        await DDLManager.applyRelationFK(
          db,
          targetTable,
          fkInTarget,
          sourceTable,
          data.on_delete,
          data.on_update,
        );
        // Virtual alias on the source collection (no physical column on source)
        fieldsToAdd.push([
          data.source_collection,
          {
            name: data.source_field,
            type: 'o2m',
            options: { related_collection: data.target_collection, related_field: fkInTarget },
          },
        ]);
        // Physical FK column on the target collection — without this, processInput
        // in data.ts silently drops the field on insert/update because it isn't
        // in the target's `fields` array, leaving the column NULL.
        fieldsToAdd.push([
          data.target_collection,
          {
            name: fkInTarget,
            type: 'm2o',
            options: { related_collection: data.source_collection },
          },
        ]);
      } else if (data.type === 'm2m') {
        junctionTable = await DDLManager.createJunctionTable(
          db,
          data.source_collection,
          data.target_collection,
        );
        fieldsToAdd.push([
          data.source_collection,
          {
            name: data.source_field,
            type: 'm2m',
            options: { related_collection: data.target_collection },
          },
        ]);
      }
      // m2a: virtual — no DDL needed, just metadata

      // The DDL above cannot join this transaction (CREATE INDEX CONCURRENTLY) and
      // is idempotent on retry; the metadata it is described by can, and does.
      const relRow = await db.transaction().execute(async (trx) => {
        for (const [collection, field] of fieldsToAdd) {
          await addFieldToCollection(trx, collection, field);
        }
        return trx
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
            metadata: data.metadata,
          })
          .returningAll()
          .executeTakeFirst();
      });
      fieldsChanged(...fieldsToAdd.map(([collection]) => collection));

      return c.json({ relation: normalize(relRow) }, 201);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
        if (relation.type === 'm2o') {
          await dynamicDropColumn(trx, sourceTable, relation.source_field);
          await removeFieldFromCollection(trx, relation.source_collection, relation.source_field);
        } else if (relation.type === 'o2m') {
          const fkInTarget = relation.target_field || `${relation.source_collection}_id`;
          await dynamicDropColumn(trx, targetTable, fkInTarget);
          await removeFieldFromCollection(trx, relation.source_collection, relation.source_field);
          await removeFieldFromCollection(trx, relation.target_collection, fkInTarget);
        } else if (relation.type === 'm2m' && relation.junction_table) {
          await DDLManager.dropJunctionTable(trx, relation.junction_table);
          await removeFieldFromCollection(trx, relation.source_collection, relation.source_field);
        }
        // m2a: no DDL to undo

        await trx.deleteFrom('zvd_relations').where('id', '=', relation.id).execute();
      });
      fieldsChanged(relation.source_collection, relation.target_collection);

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
