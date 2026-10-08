/**
 * Collection permissions, enforced by the database (roadmap R1).
 *
 * Four RESTRICTIVE policies per collection table, one per command, each asking
 * `zveltio_collection_allows(<collection>, <action>)` (migration 058) — which
 * reads the permissions the request published. Postgres ANDs them with the
 * tenant policy and the row-rule policy, so a path that forgets the
 * application's `checkPermission` is refused by the table itself.
 *
 *   SELECT → read · INSERT → create · UPDATE → update · DELETE → delete
 *
 * Applied from `applyTenantRLS`, which every collection creator and the boot
 * reconcile go through, so a collection never exists without them. Junction
 * tables (`zvd_jnc_*`) carry none: a link belongs to two collections, and its
 * reads and writes come through the relation code of the collection that owns
 * it, which this already governs.
 *
 * What Postgres adds on top, and the engine must respect: `INSERT … RETURNING`
 * and `UPDATE … WHERE` also need the SELECT policy, so `create` or `update`
 * without `read` succeeds only for statements that do not read the row back.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const COMMANDS = [
  { cmd: 'SELECT', act: 'read', using: true, check: false },
  { cmd: 'INSERT', act: 'create', using: false, check: true },
  { cmd: 'UPDATE', act: 'update', using: true, check: true },
  { cmd: 'DELETE', act: 'delete', using: true, check: false },
] as const;

/** Policy name for one action — `zv_coll_read` and so on. */
export const collectionPolicyName = (act: string) => `zv_coll_${act}`;

const COLLECTION_TABLE = /^zvd_([a-z][a-z0-9_]*)$/;

/** The collection a table belongs to, or null for a table that is not one. */
export function collectionOfTable(table: string): string | null {
  if (table.startsWith('zvd_jnc_')) return null;
  return COLLECTION_TABLE.exec(table)?.[1] ?? null;
}

/** Whether migration 058's function is there — absent on a database not yet migrated. */
async function functionPresent(db: Database): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT to_regprocedure('zveltio_collection_allows(text, text)') IS NOT NULL AS ok
  `.execute(db);
  return r.rows[0]?.ok === true;
}

/**
 * (Re)create the four policies on `table`. A no-op for a table that is not a
 * collection's, or on a database without migration 058.
 */
export async function applyCollectionPermissions(db: Database, table: string): Promise<boolean> {
  // A name that is not `zvd_<identifier>` never reaches the SQL below.
  if (!COLLECTION_TABLE.test(table)) return false;
  const collection = collectionOfTable(table);
  if (!collection) return false;
  if (!(await functionPresent(db))) return false;
  // One transaction. These are RESTRICTIVE: between a DROP and its CREATE on
  // the pool the table had no such restriction, and every concurrent statement
  // ran unchecked — on every boot's reconcile, for every collection (measured:
  // 23 of 202 reads by a caller with no grant saw rows while it re-ran).
  const recreate = async (h: Database) => {
    for (const { cmd, act, using, check } of COMMANDS) {
      const name = collectionPolicyName(act);
      // The collection name is a literal in the policy: matched by the regex
      // above, so it cannot carry a quote.
      const allows = `(SELECT zveltio_collection_allows('${collection}', '${act}'))`;
      await sql`DROP POLICY IF EXISTS ${sql.id(name)} ON ${sql.id(table)}`.execute(h);
      await sql
        .raw(
          `CREATE POLICY ${name} ON "${table}" AS RESTRICTIVE FOR ${cmd}` +
            (using ? ` USING (${allows})` : '') +
            (check ? ` WITH CHECK (${allows})` : ''),
        )
        .execute(h);
    }
  };
  if ((db as unknown as { isTransaction?: boolean }).isTransaction) await recreate(db);
  else await db.transaction().execute(recreate);
  return true;
}

/**
 * An API key's scopes as the grants the policies read — the same union
 * `checkAccess` computes: an entry naming the collection or `*` grants its
 * actions, `*` grants every action, `write` grants create and update. A
 * malformed or empty scope list grants nothing, as it does there.
 */
export function encodeApiKeyScopes(raw: unknown): { all: boolean; grants: string } {
  let scopes: unknown = raw;
  if (typeof raw === 'string') {
    try {
      scopes = JSON.parse(raw);
    } catch {
      return { all: false, grants: '' };
    }
  }
  if (!Array.isArray(scopes)) return { all: false, grants: '' };
  let all = false;
  const parts = new Set<string>();
  for (const s of scopes as Array<{ collection?: unknown; actions?: unknown }>) {
    const coll = typeof s?.collection === 'string' ? s.collection : null;
    if (!coll || coll.includes(',') || coll.includes(':')) continue;
    const actions = Array.isArray(s.actions) ? s.actions.filter((a) => typeof a === 'string') : [];
    for (const a of actions as string[]) {
      if (a.includes(',') || a.includes(':')) continue;
      if (a === '*') {
        if (coll === '*') all = true;
        else parts.add(`${coll}:*`);
      } else if (a === 'write') {
        parts.add(`${coll}:create`);
        parts.add(`${coll}:update`);
      } else {
        parts.add(`${coll}:${a}`);
      }
    }
  }
  return { all, grants: parts.size > 0 ? `,${[...parts].join(',')},` : '' };
}
