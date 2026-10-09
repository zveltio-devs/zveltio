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
  for (const { cmd, act, using, check } of COMMANDS) {
    const name = collectionPolicyName(act);
    // The collection name is a literal in the policy: matched by the regex
    // above, so it cannot carry a quote.
    const allows = `(SELECT zveltio_collection_allows('${collection}', '${act}'))`;
    await sql`DROP POLICY IF EXISTS ${sql.id(name)} ON ${sql.id(table)}`.execute(db);
    await sql
      .raw(
        `CREATE POLICY ${name} ON "${table}" AS RESTRICTIVE FOR ${cmd}` +
          (using ? ` USING (${allows})` : '') +
          (check ? ` WITH CHECK (${allows})` : ''),
      )
      .execute(db);
  }
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
 * Overlapping windows on one transaction widen and restore together, as
 * `asSystem`'s do. Outside a transaction there is no actor, so nothing to open.
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
    // Re-read next time: the actor may be republished (an API key) in between.
    if (win.open.length === 0) readWindows.delete(trx);
    // An aborted transaction fails this too, and its rollback discards the setting.
    await writeReadWindow(trx, win).catch(() => undefined);
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
