/**
 * Renaming, retyping, requiring and dropping a field of a collection.
 *
 * `PATCH` and `DELETE /api/collections/:name/fields/:field` and the schema
 * migrations of `POST /api/admin/schema/apply` (RFC schema-as-code §4.4) all
 * run these, so a field changes one way whichever door it came through.
 */

import type { Database } from '../../db/index.js';
import {
  dynamicChangeColumnType,
  dynamicDropColumn,
  dynamicRenameColumn,
  dynamicSetColumnRequired,
} from '../../db/dynamic.js';
import { auditLog } from '../audit.js';
import { DDLManager, SYSTEM_COLUMNS } from './ddl-manager.js';
import { announceSchemaChange } from './ddl-queue.js';
import { resolveConversion } from './field-type-conversions.js';
import { fieldTypeRegistry } from './field-type-registry.js';

const ALL_RELATION_TYPES = new Set(['m2o', 'reference', 'o2m', 'm2m']);
const SAFE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** A refusal with the HTTP status the collection routes answer it with. */
export class FieldChangeError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

/**
 * Why `collection` may not take this kind of schema change, or null. Unmanaged
 * (BYOD) collections take none; a schema-locked one takes only additions.
 * `ddl-queue.ts` enforces the same rule for the async DDL jobs.
 */
export async function schemaChangeRefusal(
  db: Database,
  collectionName: string,
  op: 'add' | 'remove' | 'drop',
): Promise<string | null> {
  const meta = await db
    .selectFrom('zvd_collections')
    .select(['is_managed', 'schema_locked'])
    .where('name', '=', collectionName)
    .executeTakeFirst();
  if (!meta) return null; // collection-not-found is handled by caller
  if (meta.is_managed === false) {
    return `Collection '${collectionName}' is unmanaged (BYOD). Schema changes are not allowed.`;
  }
  if (meta.schema_locked === true && op !== 'add') {
    return `Collection '${collectionName}' is schema-locked. ${op === 'drop' ? 'Dropping' : 'Removing fields from'} it is not allowed.`;
  }
  return null;
}

type FieldDef = { name: string; type: string; required?: boolean; [k: string]: unknown };

async function fieldsOf(db: Database, name: string, fieldName: string, op: 'add' | 'remove') {
  if (!SAFE_NAME_RE.test(fieldName)) throw new FieldChangeError('Invalid field name', 400);
  const collection = await DDLManager.getCollection(db, name);
  if (!collection) throw new FieldChangeError('Collection not found', 404);
  const guardError = await schemaChangeRefusal(db, name, op);
  if (guardError) throw new FieldChangeError(guardError, 403);
  let fields: FieldDef[];
  try {
    fields =
      typeof collection.fields === 'string'
        ? JSON.parse(collection.fields)
        : ((collection.fields as unknown as FieldDef[]) ?? []);
  } catch {
    fields = [];
  }
  const fieldDef = fields.find((f) => f.name === fieldName);
  if (!fieldDef) {
    throw new FieldChangeError(`Field "${fieldName}" not found in collection "${name}"`, 404);
  }
  return { fields, fieldDef };
}

/** Changes a field's type (through `resolveConversion`), its `required` flag and its name, in that order. */
export async function alterField(
  db: Database,
  name: string,
  fieldName: string,
  change: { newName?: string; newType?: string; required?: boolean },
  userId?: string,
): Promise<{ field: FieldDef; actions: string[] }> {
  const { newName, newType, required } = change;
  if (SYSTEM_COLUMNS.has(fieldName) || (newName && SYSTEM_COLUMNS.has(newName))) {
    throw new FieldChangeError('Cannot modify system fields', 400);
  }
  if (newName !== undefined && !SAFE_NAME_RE.test(newName)) {
    throw new FieldChangeError('Invalid field name', 400);
  }
  // rename/type/required keep the column → "add" semantics
  const { fields, fieldDef } = await fieldsOf(db, name, fieldName, 'add');

  const isRelation = ALL_RELATION_TYPES.has(fieldDef.type);

  if (newName) {
    if (newName === fieldName) {
      throw new FieldChangeError('New name is identical to the current name', 400);
    }
    if (fields.some((f) => f.name === newName)) {
      throw new FieldChangeError(`Field "${newName}" already exists in collection "${name}"`, 409);
    }
  }
  if (newType && isRelation) {
    throw new FieldChangeError(
      'Changing type on a relation field is not supported. Delete and re-add the field.',
      400,
    );
  }
  if (newType && fieldDef.type === 'computed') {
    throw new FieldChangeError('Computed fields cannot change type via this endpoint.', 400);
  }
  if (
    required !== undefined &&
    isRelation &&
    fieldDef.type !== 'm2o' &&
    fieldDef.type !== 'reference'
  ) {
    throw new FieldChangeError(
      'Toggling required is only supported on m2o/reference relations among relation types.',
      400,
    );
  }

  const tableName = DDLManager.getTableName(name);
  const actions: string[] = [];
  let updatedFieldShape: FieldDef = { ...fieldDef };

  // Altering a field is DDL plus the metadata that describes it, and the
  // two must not come apart.
  //
  // A rename that changes the physical column but not `zvd_relations` and
  // `zvd_collections.fields` leaves the collection definition pointing at
  // a column that no longer exists — every query built from that
  // definition fails, and the only repair is editing metadata by hand.
  // The reverse leaves metadata describing a column the table does not
  // have. Postgres runs DDL inside transactions, so this is one of the
  // few places where the schema change and its bookkeeping genuinely can
  // roll back together.
  await db.transaction().execute(async (trx) => {
    // ── 1) Type change ────────────────────────────────────────────
    if (newType && newType !== fieldDef.type) {
      if (!fieldTypeRegistry.has(newType)) {
        // `return` here would be a return from THIS callback, captured by
        // `.execute()`'s promise and discarded — not from the outer route
        // handler. Throwing is what actually reaches the `catch` below and
        // turns into an HTTP error instead of a silent no-op 200.
        throw new Error(`Unknown field type: "${newType}"`);
      }
      const targetDef = fieldTypeRegistry.get(newType)!;
      const targetSqlType = targetDef.db.columnType;
      const conv = resolveConversion(fieldDef.type, newType, targetSqlType, fieldName);
      if (!conv.ok) {
        throw new Error(conv.reason);
      }
      await dynamicChangeColumnType(trx, tableName, fieldName, conv.sqlType, conv.using);
      updatedFieldShape = { ...updatedFieldShape, type: newType };
      actions.push(`type ${fieldDef.type}→${newType}`);
    }

    // ── 2) Required toggle ────────────────────────────────────────
    if (required !== undefined && required !== !!fieldDef.required) {
      await dynamicSetColumnRequired(trx, tableName, fieldName, required);
      updatedFieldShape = { ...updatedFieldShape, required };
      actions.push(`required→${required}`);
    }

    // ── 3) Rename ─────────────────────────────────────────────────
    if (newName && newName !== fieldName) {
      if (isRelation) {
        // Physical column rename only for m2o/reference (FK on source).
        // o2m/m2m fields are metadata on the source side; we only
        // update zvd_relations + zvd_collections.fields.
        if (fieldDef.type === 'm2o' || fieldDef.type === 'reference') {
          await dynamicRenameColumn(trx, tableName, fieldName, newName);
        }
        await trx
          .updateTable('zvd_relations')
          .set({ source_field: newName })
          .where('source_collection', '=', name)
          .where('source_field', '=', fieldName)
          .execute();
      } else {
        await dynamicRenameColumn(trx, tableName, fieldName, newName);
        // Also sync any zvd_relations rows where this is the target_field
        // (i.e. another collection has an o2m pointing at this column).
        await trx
          .updateTable('zvd_relations')
          .set({ target_field: newName })
          .where('target_collection', '=', name)
          .where('target_field', '=', fieldName)
          .execute();
      }
      updatedFieldShape = { ...updatedFieldShape, name: newName };
      actions.push(`renamed ${fieldName}→${newName}`);
    }

    // ── Persist metadata ──────────────────────────────────────────
    const finalName = updatedFieldShape.name;
    const updatedFields = fields.map((f) => (f.name === fieldName ? updatedFieldShape : f));
    await DDLManager.updateCollectionMetadata(trx, name, { fields: updatedFields as never });

    await auditLog(trx, {
      type: 'settings.changed',
      userId,
      resourceId: name,
      resourceType: 'collection_field',
      metadata: { actions, from: fieldName, to: finalName },
    });
  });
  announceSchemaChange(name, 'alter');
  return { field: updatedFieldShape, actions };
}

/** Drops a field: its column (or, for o2m and m2m, the column or junction it stands for), its relation and its metadata. */
export async function dropField(
  db: Database,
  name: string,
  fieldName: string,
  userId?: string,
): Promise<void> {
  if (SYSTEM_COLUMNS.has(fieldName)) {
    throw new FieldChangeError(`"${fieldName}" is a reserved system field name`, 400);
  }
  const { fields } = await fieldsOf(db, name, fieldName, 'remove');
  const tableName = DDLManager.getTableName(name);
  const fieldDef = fields.find((f) => f.name === fieldName);

  // DROP and metadata in one transaction: separately, a failed metadata write
  // left the collection describing a column the table no longer has.
  await db.transaction().execute(async (trx) => {
    if (fieldDef?.type === 'o2m') {
      // o2m: FK column lives in TARGET table — look up and drop it there
      const relation = await trx
        .selectFrom('zvd_relations')
        .select(['target_collection', 'target_field'])
        .where('source_collection', '=', name)
        .where('source_field', '=', fieldName)
        .executeTakeFirst();
      if (relation?.target_collection && relation?.target_field) {
        const targetTable = DDLManager.getTableName(relation.target_collection);
        await dynamicDropColumn(trx, targetTable, relation.target_field);
      }
    } else if (fieldDef?.type === 'm2m') {
      // m2m: drop the junction table (no column in source table)
      const relation = await trx
        .selectFrom('zvd_relations')
        .select(['junction_table'])
        .where('source_collection', '=', name)
        .where('source_field', '=', fieldName)
        .executeTakeFirst();
      if (relation?.junction_table) {
        await DDLManager.dropJunctionTable(trx, relation.junction_table);
      }
    } else {
      await dynamicDropColumn(trx, tableName, fieldName);
    }

    // Drop the relation row (dangling metadata causes re-add to hit UNIQUE
    // constraint). No `.catch`: inside the transaction a failure aborts it anyway.
    await trx
      .deleteFrom('zvd_relations')
      .where('source_collection', '=', name)
      .where('source_field', '=', fieldName)
      .execute();

    const updatedFields = fields.filter((f) => f.name !== fieldName);
    await DDLManager.updateCollectionMetadata(trx, name, { fields: updatedFields as never });
  });
  DDLManager.invalidateCache(name);
  announceSchemaChange(name, 'alter');
  await auditLog(db, {
    type: 'settings.changed',
    userId,
    resourceId: name,
    resourceType: 'collection_field',
    metadata: { action: 'removed', field: fieldName },
  });
}
