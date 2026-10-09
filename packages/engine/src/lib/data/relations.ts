/**
 * Creating a relation: its foreign key or junction table, the fields that
 * stand for it, and its `zvd_relations` row. `POST /api/relations` and
 * `POST /api/admin/schema/apply` both run `createRelation`.
 */

import { z } from 'zod';
import type { Database } from '../../db/index.js';
import { toJsonb } from '../jsonb.js';
import { DDLManager } from './ddl-manager.js';
import { announceSchemaChange } from './ddl-queue.js';
import { FieldChangeError } from './field-changes.js';

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export const RelationSchema = z.object({
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
export async function addFieldToCollection(
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

/**
 * Remove a field from collection.fields JSON (row-locked), with the rules that
 * name it. Before the field's column is dropped: see `DDLManager.dropFieldRules`.
 */
export async function removeFieldFromCollection(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  trx: any,
  collectionName: string,
  fieldName: string,
): Promise<void> {
  await DDLManager.dropFieldRules(trx, collectionName, fieldName);
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
export function fieldsChanged(...collections: string[]): void {
  for (const name of new Set(collections)) {
    DDLManager.invalidateCache(name);
    announceSchemaChange(name, 'alter');
  }
}

type FieldDef = { name: string; type: string; options?: Record<string, unknown> };

/**
 * Creates the relation `data` describes. `defs` replaces the field definitions
 * the relation would write — the source field, and for an o2m the target's
 * foreign key — so a caller that knows the whole field (label, required…)
 * does not get a bare one.
 */
export async function createRelation(
  db: Database,
  data: z.infer<typeof RelationSchema>,
  defs: { source?: FieldDef; target?: FieldDef } = {},
) {
  const [sourceExists, targetExists] = await Promise.all([
    DDLManager.tableExists(db, data.source_collection),
    DDLManager.tableExists(db, data.target_collection),
  ]);

  if (!sourceExists) {
    throw new FieldChangeError(`Source collection '${data.source_collection}' not found`, 404);
  }
  if (!targetExists) {
    throw new FieldChangeError(`Target collection '${data.target_collection}' not found`, 404);
  }

  // Check for duplicate
  const existing = await db
    .selectFrom('zvd_relations')
    .select(['id'])
    .where('source_collection', '=', data.source_collection)
    .where('source_field', '=', data.source_field)
    .executeTakeFirst();

  if (existing) {
    throw new FieldChangeError(
      `A relation already exists on '${data.source_collection}.${data.source_field}'`,
      409,
    );
  }

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
      defs.source ?? {
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
      defs.source ?? {
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
      defs.target ?? {
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
      defs.source ?? {
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

  return relRow;
}
