/**
 * Columns served to no one, sealed in the database too (L37, layer 2), and
 * columns hidden from a role, masked in the database too (layer 3).
 *
 * A `password` field's hash is stripped from every payload, god's included
 * (`withheldColumns().unserved`), but stripping is the engine remembering to:
 * raw SQL on the request role read it back. `zveltio_seal_columns()` (migration
 * 073) takes SELECT on such a column from every role but the owner, so the
 * database refuses it instead. The engine reads these tables by naming the
 * columns it may (`readableColumns` in `db/dynamic.ts`).
 *
 * `zveltio_mask_columns()` (migration 075) does that and builds the collection's
 * view `zvv_<name>`, which masks the columns `zvd_column_permissions` hides from
 * the actor; the request roles lose those columns on the table and the engine
 * reads through the view (`readSource`).
 *
 * Applied on collection create (in the CREATE's transaction), on every field
 * change (`updateCollectionMetadata`), on every column rule change
 * (`invalidateColumnPermCache`) and at boot. A transaction that alters a
 * collection's columns starts with `dropMaskView` and ends here.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { forgetReadableColumns, maskViewName } from '../../db/dynamic.js';
import { SEARCH_FIELD_TYPES, SYSTEM_COLUMNS } from './ddl-manager.js';
import { fieldTypeRegistry } from './field-type-registry.js';

type FieldLike = { name?: unknown; type?: unknown };

/** The fields whose type serializes to nothing (`password`): served to no one, god included. */
export function unservedFields(fields: ReadonlyArray<FieldLike>): string[] {
  return fields
    .filter((f) => fieldTypeRegistry.get(String(f?.type))?.typescript.outputType === 'undefined')
    .map((f) => String(f.name));
}

/** A collection's fields as stored — not the cached definition, which may be another replica's past. */
export async function storedFields(db: Database, collection: string): Promise<FieldLike[]> {
  const row = await db
    .selectFrom('zvd_collections')
    .select('fields')
    .where('name', '=', collection)
    .executeTakeFirst();
  const raw: unknown = row?.fields;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? (parsed as FieldLike[]) : [];
}

/** A `text[]` parameter, in the form Bun.SQL binds whatever the array holds. */
function textArray(values: readonly string[]) {
  return sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::text::jsonb))`;
}

/**
 * Seal a collection's unserved columns from every role but the table's owner,
 * or give them back when none is left, and rebuild its masking view. Joins the
 * caller's transaction: on create it runs in the CREATE's, so the table never
 * exists unsealed with data. Returns whether the grants or the view changed.
 *
 * `fields` must be the fields the table has NOW: a password column missing from
 * them is unsealed and put in the view. `withheld` are columns treated as
 * unserved besides (a Ghost DDL copy's new column, before its field is recorded).
 */
export async function sealColumns(
  db: Database,
  collection: string,
  fields?: ReadonlyArray<FieldLike>,
  withheld: readonly string[] = [],
): Promise<boolean> {
  const table = `zvd_${collection}`;
  if (!/^zvd_[a-z][a-z0-9_]*$/.test(table)) return false;
  const list = fields ?? (await storedFields(db, collection));
  const unserved = [...unservedFields(list), ...withheld];
  const search = list
    .filter((f) => SEARCH_FIELD_TYPES.has(String(f?.type)))
    .map((f) => String(f.name));
  const r = await sql<{ changed: boolean | null }>`
    SELECT zveltio_mask_columns(
             to_regclass(${`public.${table}`}),
             ${textArray(unserved)}, ${textArray([...SYSTEM_COLUMNS])}, ${textArray(search)}
           ) AS changed
  `.execute(db);
  forgetReadableColumns(table);
  return r.rows[0]?.changed === true;
}

/**
 * Drop a collection's masking view, first thing in a transaction that alters its
 * columns: Postgres refuses to drop or retype a column a view reads, and taking
 * the view before the table is the order a reader takes them. The transaction
 * ends with `sealColumns`, which builds it again.
 */
export async function dropMaskView(db: Database, table: string): Promise<void> {
  const view = maskViewName(table);
  if (!view) return;
  await sql`DROP VIEW IF EXISTS ${sql.table(`public.${view}`)}`.execute(db);
  forgetReadableColumns(table);
}

/**
 * Seal and mask every collection. Run at boot: an install upgrading into 073 or
 * 075 has the fields and rules and none of the grants or views, and the boot
 * grant loops re-run each start. A settled table is catalog reads, no lock.
 */
export async function reconcileSealedColumns(db: Database): Promise<number> {
  const rows = await db.selectFrom('zvd_collections').select(['name', 'fields']).execute();
  let n = 0;
  for (const r of rows) {
    const raw: unknown = r.fields;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const fields = Array.isArray(parsed) ? (parsed as FieldLike[]) : [];
    const changed = await sealColumns(db, r.name, fields).catch((err: Error) => {
      console.warn(`[sealed-columns] ${r.name}: could not apply — ${err.message}`);
      return false;
    });
    if (changed) n++;
  }
  return n;
}
