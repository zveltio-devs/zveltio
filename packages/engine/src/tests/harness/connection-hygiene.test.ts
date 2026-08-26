/**
 * A connection must never go back to the pool carrying a tenant's role or GUCs.
 *
 * Today Postgres guarantees this and the engine does nothing to earn it:
 * `SET LOCAL ROLE` and `set_config(..., is_local => true)` are undone by COMMIT,
 * so the guarantee is the transaction's. That is exactly why this test is
 * written BEFORE the transaction boundary moves. Any variant that shortens the
 * transaction — or removes it, as option B in the handoff document does — moves
 * the cleanup out of Postgres and into our code, and the day that happens this
 * file is what says whether it worked. Written afterwards, it would be written
 * against whatever the new code happens to do.
 *
 * The pool is pinned to ONE connection on purpose. With the default pool the
 * query after the transaction lands on whichever backend is free, so a clean
 * reading proves nothing: it may simply be a different connection that was
 * never dirtied. `max: 1` makes "the same backend" the only possibility, and
 * `pg_backend_pid()` is asserted rather than assumed.
 *
 * The second case is the one that keeps the first honest. A test that only
 * asserts cleanliness passes just as happily when it has lost the ability to
 * see dirt at all — so the same detector is pointed at a deliberately dirtied
 * connection and required to report it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqlDialect } from '../../db/bun-sql-dialect.js';
import type { Database } from '../../db/index.js';
import type { DbSchema } from '../../db/schema.js';
import {
  DEFAULT_TENANT_ID,
  initTenantManager,
  withTenantIsolation,
} from '../../lib/tenancy/tenant-manager.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

/** Everything a released connection must not be carrying. */
interface ConnectionState {
  pid: number;
  role: string;
  currentTenant: string;
  visibleTenants: string;
  ancestorTenants: string;
}

async function readState(db: Database): Promise<ConnectionState> {
  const r = await sql<ConnectionState>`
    SELECT pg_backend_pid()                                              AS pid,
           current_user                                                  AS role,
           coalesce(current_setting('zveltio.current_tenant',   true), '') AS "currentTenant",
           coalesce(current_setting('zveltio.visible_tenants',  true), '') AS "visibleTenants",
           coalesce(current_setting('zveltio.ancestor_tenants', true), '') AS "ancestorTenants"
  `.execute(db);
  return r.rows[0];
}

/** The detector, named once so both cases are judged by the same rule. */
function tenantResidue(s: ConnectionState): string[] {
  const found: string[] = [];
  if (s.role === 'zveltio_rls') found.push(`role=${s.role}`);
  if (s.currentTenant !== '') found.push(`zveltio.current_tenant=${s.currentTenant}`);
  if (s.visibleTenants !== '') found.push(`zveltio.visible_tenants=${s.visibleTenants}`);
  if (s.ancestorTenants !== '') found.push(`zveltio.ancestor_tenants=${s.ancestorTenants}`);
  return found;
}

d('connection hygiene', () => {
  let own: Database;
  let restore: Database;

  beforeAll(async () => {
    const { db } = await getTestApp();
    restore = db;
    own = new Kysely<DbSchema>({
      dialect: new BunSqlDialect({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 1,
      }),
    });
    // Point the tenant manager at the single-connection pool so the code under
    // test is the real `withTenantIsolation`, not a re-typed copy of it. The
    // RLS-role availability flag stays as the harness boot resolved it.
    initTenantManager(own);
  });

  afterAll(async () => {
    initTenantManager(restore);
    await own.destroy().catch(() => undefined);
  });

  it('a tenant transaction leaves nothing behind on the connection it used', async () => {
    const before = await readState(own);
    expect(tenantResidue(before)).toEqual([]);

    const inside = await withTenantIsolation(DEFAULT_TENANT_ID, (trx) => readState(trx));

    // The transaction did what it claims — otherwise "clean afterwards" would
    // only mean it never set anything.
    expect(inside.pid).toBe(before.pid);
    expect(inside.currentTenant).toBe(DEFAULT_TENANT_ID);

    const after = await readState(own);
    expect(after.pid).toBe(before.pid); // same physical backend, not a fresh one
    expect(tenantResidue(after)).toEqual([]);
  });

  it('the visible-set GUCs do not survive the transaction either', async () => {
    // These two are newer than the role and the tenant id, and they are the
    // ones that decide what a request can SEE. A leaked `visible_tenants` does
    // not fail closed — it widens the next request on that connection.
    const before = await readState(own);

    const inside = await withTenantIsolation(
      DEFAULT_TENANT_ID,
      (trx) => readState(trx),
      // No user: the reach resolves to nothing and the GUCs are written empty,
      // which is the path every background worker takes.
      { userId: null },
    );
    expect(inside.pid).toBe(before.pid);

    const after = await readState(own);
    expect(after.visibleTenants).toBe('');
    expect(after.ancestorTenants).toBe('');
    expect(tenantResidue(after)).toEqual([]);
  });

  it('and the detector can actually see a dirty connection', async () => {
    // Without this case the two above would keep passing on the day the
    // detector stops working — which is the failure mode of every test that
    // only ever asserts the good state.
    //
    // Session-level SET, deliberately: no transaction, so nothing undoes it.
    // This is precisely what option B in the handoff document would do on
    // every borrow, and the reason it needs this test before it is built.
    const before = await readState(own);
    await sql.raw(`SET zveltio.current_tenant = '${DEFAULT_TENANT_ID}'`).execute(own);
    await sql.raw(`SET zveltio.visible_tenants = '${DEFAULT_TENANT_ID}'`).execute(own);
    await sql
      .raw('SET ROLE zveltio_rls')
      .execute(own)
      .catch(() => undefined);

    const dirty = await readState(own);
    expect(dirty.pid).toBe(before.pid);
    const residue = tenantResidue(dirty);
    expect(residue).toContain(`zveltio.current_tenant=${DEFAULT_TENANT_ID}`);
    expect(residue).toContain(`zveltio.visible_tenants=${DEFAULT_TENANT_ID}`);

    // DISCARD ALL is what option B would have to issue on release. Asserting it
    // works here means the eventual implementation has a known-good recipe
    // rather than a guess.
    await sql.raw('RESET ROLE').execute(own);
    await sql.raw('DISCARD ALL').execute(own);
    const cleaned = await readState(own);
    expect(cleaned.pid).toBe(before.pid);
    expect(tenantResidue(cleaned)).toEqual([]);
  });
});
