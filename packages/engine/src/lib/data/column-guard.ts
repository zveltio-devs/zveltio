/**
 * Column write permissions, put onto the collection's table (L37, layer 1).
 *
 * `zvd_column_permissions` is enforced by `filterWritableFields`, which a write
 * path has to remember to call. This compiles the same rows into the argument of
 * a `zveltio_column_guard()` trigger (migration 072), so a path that forgets —
 * sync push did, once — is refused by the database instead. The engine's filter
 * stays first: it answers with a 403 naming the fields before the statement runs.
 *
 * Rebuilt wholesale on every change, like the row-rule policy: the rules are a
 * set, and a trigger built from half of one is the failure this exists to stop.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { withLockWaitBound } from '../../db/dynamic.js';
import { startReconcile } from '../tenancy/index.js';
import { SYSTEM_COLUMNS } from './ddl-manager.js';

/** The trigger's name. Sorts before the engine's own BEFORE triggers, so it sees the caller's row. */
export const COLUMN_GUARD_TRIGGER = '_zv_column_guard';

/**
 * The trigger argument for one collection's rows, or null when nothing is
 * restricted. A column is restricted for a role when it cannot be read or
 * cannot be written — `filterWritableFields` blocks both.
 */
export function compileColumnGuard(
  rows: Array<{ role: string; column_name: string; can_read: boolean; can_write: boolean }>,
): string | null {
  const roles: Record<string, string[]> = {};
  for (const r of rows) {
    if (r.can_read && r.can_write) continue;
    if (SYSTEM_COLUMNS.has(r.column_name)) continue;
    const cols = roles[r.role] ?? [];
    if (!cols.includes(r.column_name)) cols.push(r.column_name);
    roles[r.role] = cols;
  }
  if (Object.keys(roles).length === 0) return null;
  return JSON.stringify({ roles, system: [...SYSTEM_COLUMNS] });
}

/** A single-quoted SQL literal. */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** A double-quoted identifier. */
function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Put a collection's column write restrictions onto its table, or take them off.
 *
 * Joins the caller's transaction when there is one — `createIsolatedTable`
 * calls it in the CREATE's, so a table is created guarded or not at all. The
 * lock wait is bounded either way (`withLockWaitBound`).
 */
export async function applyColumnGuard(db: Database, collection: string): Promise<boolean> {
  const table = `zvd_${collection}`;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) return false;
  const run = async (h: Database): Promise<boolean> => {
    const rel = `public.${q(table)}`;
    const exists = await sql<{ ok: boolean }>`SELECT to_regclass(${rel}) IS NOT NULL AS ok`.execute(
      h,
    );
    if (!exists.rows[0]?.ok) return false;
    // Locked before the rules are read: two rebuilds serialize on it, so the one
    // that read the older rules cannot write last. SHARE ROW EXCLUSIVE is what
    // CREATE TRIGGER takes; writers wait, readers do not.
    await sql.raw(`LOCK TABLE ${q(table)} IN SHARE ROW EXCLUSIVE MODE`).execute(h);
    const rows = await h
      .selectFrom('zvd_column_permissions')
      .select(['role', 'column_name', 'can_read', 'can_write'])
      .where('collection_name', '=', collection)
      .execute();
    const spec = compileColumnGuard(rows);
    if (!spec) {
      await sql.raw(`DROP TRIGGER IF EXISTS ${COLUMN_GUARD_TRIGGER} ON ${q(table)}`).execute(h);
      return false;
    }
    await sql
      .raw(
        `CREATE OR REPLACE TRIGGER ${COLUMN_GUARD_TRIGGER} BEFORE INSERT OR UPDATE ON ${q(table)} ` +
          `FOR EACH ROW EXECUTE FUNCTION zveltio_column_guard(${lit(spec)})`,
      )
      .execute(h);
    return true;
  };
  return withLockWaitBound(db, run);
}

/**
 * Guard every collection that has restrictions, and unguard every table that
 * no longer does. Run at boot: an install upgrading into 072 has rules and no
 * triggers, and nothing else would create them.
 */
export async function reconcileColumnGuards(db: Database): Promise<number> {
  const record = startReconcile('column_guards');
  const rows = await sql<{ name: string }>`
    SELECT DISTINCT collection_name AS name FROM zvd_column_permissions
     WHERE NOT (can_read AND can_write)
    UNION
    SELECT substr(c.relname, 5) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = ${COLUMN_GUARD_TRIGGER} AND starts_with(c.relname, 'zvd_')
  `
    .execute(db)
    .catch((err: Error) => {
      record('*', err);
      throw err;
    });
  let n = 0;
  for (const r of rows.rows) {
    const guarded = await applyColumnGuard(db, r.name).catch((err: Error) => {
      console.warn(`[column-guard] ${r.name}: could not apply — ${record(r.name, err)}`);
      return false;
    });
    if (guarded) n++;
  }
  return n;
}
