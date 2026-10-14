/**
 * Columns served to no one, sealed in the database too (L37, layer 2).
 *
 * A `password` field's hash is stripped from every payload, god's included
 * (`withheldColumns().unserved`), but stripping is the engine remembering to:
 * raw SQL on the request role read it back. `zveltio_seal_columns()` (migration
 * 073) takes SELECT on such a column from every role but the owner, so the
 * database refuses it instead. The engine reads these tables by naming the
 * columns it may (`readableColumns` in `db/dynamic.ts`).
 *
 * Applied on collection create (in the CREATE's transaction), on every field
 * change (`updateCollectionMetadata`) and at boot.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { forgetReadableColumns } from '../../db/dynamic.js';
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

/**
 * Seal a collection's unserved columns from every role but the table's owner,
 * or give them back when none is left. Joins the caller's transaction: on
 * create it runs in the CREATE's, so the table never exists unsealed with data.
 * Returns whether the grants changed.
 */
export async function sealColumns(
  db: Database,
  collection: string,
  fields?: ReadonlyArray<FieldLike>,
): Promise<boolean> {
  const table = `zvd_${collection}`;
  if (!/^zvd_[a-z][a-z0-9_]*$/.test(table)) return false;
  const sealed = unservedFields(fields ?? (await storedFields(db, collection)));
  const r = await sql<{ changed: boolean | null }>`
    SELECT zveltio_seal_columns(
             to_regclass(${`public.${table}`}),
             ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(sealed)}::text::jsonb))
           ) AS changed
  `.execute(db);
  forgetReadableColumns(table);
  return r.rows[0]?.changed === true;
}

/**
 * Seal every collection that has an unserved field, and unseal every table that
 * is column-scoped without one. Run at boot: an install upgrading into 073 has
 * the fields and none of the grants, and the boot grant loops re-run each start.
 */
export async function reconcileSealedColumns(db: Database): Promise<number> {
  const rows = await db.selectFrom('zvd_collections').select(['name', 'fields']).execute();
  const scoped = await sql<{ name: string }>`
    SELECT DISTINCT substr(c.relname, 5) AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attacl IS NOT NULL AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND starts_with(c.relname, 'zvd_')
  `.execute(db);
  const wanted = new Map<string, FieldLike[]>();
  for (const r of rows) {
    const raw: unknown = r.fields;
    const fields = (typeof raw === 'string' ? JSON.parse(raw) : raw) as FieldLike[] | null;
    if (Array.isArray(fields) && unservedFields(fields).length > 0) wanted.set(r.name, fields);
  }
  // Only collections are unsealed: a column grant on any other table is not this file's.
  const collections = new Set(rows.map((r) => r.name));
  for (const { name } of scoped.rows) {
    if (collections.has(name) && !wanted.has(name)) wanted.set(name, []);
  }
  let n = 0;
  for (const [name, fields] of wanted) {
    const changed = await sealColumns(db, name, fields).catch((err: Error) => {
      console.warn(`[sealed-columns] ${name}: could not apply — ${err.message}`);
      return false;
    });
    if (changed) n++;
  }
  return n;
}
