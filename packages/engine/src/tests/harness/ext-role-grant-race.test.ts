/**
 * Two replicas loading extensions at the same time each end up with every one
 * of their extension's tables granted.
 *
 * Replicas that boot together run GRANTs on the same relations — every inline
 * extension's load grants every collection-like `zvd_*` table to `zveltio_ext` —
 * and Postgres rewrites the relation's ACL row for each, so the loser gets
 * XX000 "tuple concurrently updated". `grantOwnTables` ran its GRANTs in one
 * try/catch: the first collision ended the loop, and the rest of the loser's
 * grants — its OWN tables included, which no other replica grants — never ran.
 * The extension's queries then failed with `permission denied` until a restart.
 * Measured on master: rounds below left one extension's own tables ungranted.
 *
 * Two pools stand in for two replicas: separate connections, real concurrency.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import {
  _resetExtensionDbRoleForTests,
  extensionDbRoleNames,
  grantExtensionDbRole,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const N = 30;
/** Shared: granted to `zveltio_ext` by every inline extension's load. */
const SHARED = Array.from({ length: N }, (_, i) => `zvd_raceprobe_c${i}`);
const X = 'racex';
const Y = 'racey';
const OWN: Record<string, string[]> = {
  [X]: Array.from({ length: N }, (_, i) => `zv_racex_t${i}`),
  [Y]: Array.from({ length: N }, (_, i) => `zv_racey_t${i}`),
};
const ALL = [...SHARED, ...OWN[X], ...OWN[Y]];

d('extension grants racing another replica', () => {
  let db: Database;
  let a: Database;
  let b: Database;
  const role: Record<string, string> = {};

  /** Tables of this extension its own role holds SELECT on, directly. */
  const granted = async (ext: string) =>
    Number(
      (
        await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_class c, aclexplode(c.relacl) x
            JOIN pg_roles r ON r.oid = x.grantee
           WHERE c.relname = ANY(${OWN[ext]}::text[]) AND r.rolname = ${role[ext]}
             AND x.privilege_type = 'SELECT'`.execute(db)
      ).rows[0]!.n,
    );

  beforeAll(async () => {
    db = (await getTestApp()).db;
    // Shared tables first: the grant loop meets them before the own ones.
    for (const t of ALL) {
      await sql`CREATE TABLE IF NOT EXISTS ${sql.table(t)} (id int)`.execute(db);
    }
    const dbName = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!
      .d;
    for (const e of [X, Y]) role[e] = extensionDbRoleNames(dbName, e).role;
    const url = String(process.env.TEST_DATABASE_URL);
    a = createDb(url);
    b = createDb(url);
  }, 60_000);

  afterAll(async () => {
    for (const e of [X, Y]) await revokeExtensionDbRoles(db, e, true);
    _resetExtensionDbRoleForTests();
    for (const t of ALL) await sql`DROP TABLE IF EXISTS ${sql.table(t)}`.execute(db);
    await a.destroy().catch(() => {});
    await b.destroy().catch(() => {});
  });

  it('grants each extension all its own tables when the shared GRANTs collide', async () => {
    for (let round = 0; round < 8; round++) {
      // Fresh as a first boot: nothing granted yet.
      for (const e of [X, Y]) await revokeExtensionDbRoles(db, e);
      await sql`REVOKE ALL ON ${sql.join(SHARED.map((t) => sql.table(t)))} FROM zveltio_ext`.execute(
        db,
      );
      _resetExtensionDbRoleForTests();
      await Promise.all([
        grantExtensionDbRole(a, X, new Set()),
        grantExtensionDbRole(b, Y, new Set()),
      ]);
      expect([await granted(X), await granted(Y)], `round ${round}`).toEqual([N, N]);
    }
  }, 120_000);
});
