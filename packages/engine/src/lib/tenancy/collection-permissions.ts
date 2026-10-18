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
 * and `UPDATE … WHERE` also need the SELECT policy; the write handlers run their
 * own statements inside `withCollectionRead` for a caller without `read`, and
 * answer that caller with the id alone.
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

/**
 * (Re)create the four policies on `table`. A no-op for a table that is not a
 * collection's. On a database without `zveltio_collection_allows` (migration
 * 058, in the GA baseline) the CREATE POLICY fails and so does the caller: it
 * used to return quietly, and the table went on without the policies.
 */
export async function applyCollectionPermissions(db: Database, table: string): Promise<boolean> {
  // A name that is not `zvd_<identifier>` never reaches the SQL below.
  if (!COLLECTION_TABLE.test(table)) return false;
  const collection = collectionOfTable(table);
  if (!collection) return false;
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

/** Per transaction: the grants as published, and the collections read-opened over them. */
const readWindows = new WeakMap<object, { base: Promise<string>; open: string[] }>();

function writeReadWindow(trx: Database, w: { base: Promise<string>; open: string[] }) {
  return w.base.then((base) => {
    const extra = [...new Set(w.open)].map((c) => `${c}:read`).join(',');
    const grants = extra ? `${base || ','}${extra},` : base;
    return sql`SELECT set_config('zveltio.collection_grants', ${grants}, true)`.execute(trx);
  });
}

/**
 * Run the engine's OWN statements on `collection` as if the caller could read it.
 *
 * A caller with `create`, `update` or `delete` but not `read` is refused by the
 * SELECT policy wherever Postgres reads the table on a write's behalf: the
 * before-row the handlers check rules and hooks against, `UPDATE`/`DELETE …
 * WHERE id = …` (filtered to nothing, silently), `ON CONFLICT`, `RETURNING`. So
 * the engine adds `<collection>:read` to the published grants for `fn` and puts
 * them back after. Only `read`, only this collection; the tenant policy and the
 * row rules still apply.
 *
 * What runs inside must not reach the caller — it is the engine reading for
 * itself (revisions, hooks, side effects). Keep `fn` to the engine's own
 * statements: an extension hook awaited inside it would read under the window.
 * Windows on one transaction — nested, sequential or overlapping (`Promise.all`)
 * — share one base read from the published grants: every write is computed from
 * the windows open when it is issued, so the last one issued restores the base
 * once all have settled. The base is not re-read while any window is open, so a
 * republish of the actor must not run inside one. Outside a transaction there is
 * no actor, so nothing to open.
 */
export async function withCollectionRead<T>(
  trx: Database,
  collection: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!(trx as unknown as { isTransaction?: boolean }).isTransaction) return fn();
  let w = readWindows.get(trx);
  if (!w) {
    // Issued before any set_config of this window: statements on a transaction
    // run in the order they are issued, so the base is the published value.
    w = {
      base: sql<{ g: string | null }>`
        SELECT current_setting('zveltio.collection_grants', true) AS g
      `
        .execute(trx)
        .then((r) => r.rows[0]?.g ?? ''),
      open: [],
    };
    readWindows.set(trx, w);
  }
  const win = w;
  win.open.push(collection);
  try {
    await writeReadWindow(trx, win);
    return await fn();
  } finally {
    win.open.splice(win.open.indexOf(collection), 1);
    // An aborted transaction fails this too, and its rollback discards the setting.
    await writeReadWindow(trx, win).catch(() => undefined);
    // Re-read next time: the actor may be republished (an API key) in between.
    // Only once the restore has landed — a window opened before that joins this
    // entry (its base is still the published value); one opened after reads it
    // back. Dropped earlier, a new window read the widened grants as its base.
    if (win.open.length === 0 && readWindows.get(trx) === win) readWindows.delete(trx);
  }
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

/**
 * What both `a` and `b` allow, in the same encoding — an API key's scopes met
 * with its issuer's grants, so the database bounds a key as `checkAccess` does.
 * A (collection, action) is allowed by some entry of each side, so the meet of
 * every pair of entries (`*` yielding to the other side) is the intersection.
 */
export function intersectGrants(
  a: { all: boolean; grants: string },
  b: { all: boolean; grants: string },
): { all: boolean; grants: string } {
  const entries = (g: { all: boolean; grants: string }) =>
    [...(g.all ? ['*:*'] : []), ...g.grants.split(',').filter(Boolean)].flatMap((e) => {
      const at = e.lastIndexOf(':');
      const coll = e.slice(0, at);
      // A resource named with `:` is never a collection (`zvd_<identifier>`).
      return at > 0 && !coll.includes(':') ? [[coll, e.slice(at + 1)] as const] : [];
    });
  const meet = (x: string, y: string) => (x === '*' ? y : y === '*' || y === x ? x : null);
  let all = false;
  const parts = new Set<string>();
  for (const [ca, aa] of entries(a)) {
    for (const [cb, ab] of entries(b)) {
      const coll = meet(ca, cb);
      const act = meet(aa, ab);
      if (coll === null || act === null) continue;
      if (coll === '*' && act === '*') all = true;
      else parts.add(`${coll}:${act}`);
    }
  }
  return { all, grants: parts.size > 0 ? `,${[...parts].join(',')},` : '' };
}
