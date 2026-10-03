/**
 * A temp object an extension statement creates does not outlive its role window
 * where boot could not take TEMPORARY from the restricted roles.
 *
 * `restrictTemporaryObjects` needs the database owner or a superuser; elsewhere
 * `zveltio_ext` keeps TEMPORARY through PUBLIC (lib/tenancy/temp-privilege.ts).
 * pg_temp is searched first, so a `pg_temp."user"` or a shadow of any engine
 * table, left on the request transaction or on a pooled connection, is what the
 * next engine statement there reads and writes — as the engine role. The worker
 * bridge discards temp objects in that case; the `ctx.db` / `ctx.adminDb` role
 * windows did not.
 *
 * The non-owner case is the real code path: boot's restrict runs as a role that
 * owns nothing, after TEMPORARY is handed back to PUBLIC. The analyzer is
 * switched off through the seam tests/harness/extension-db-role.test.ts uses, so
 * each statement reaches Postgres as an analyzer miss would.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import * as policy from '../../lib/extensions/worker-sql-policy.js';

const realAssert = policy.assertWorkerSqlAllowed;
let analyzerOff = false;
mock.module('../../lib/extensions/worker-sql-policy.js', () => ({
  ...policy,
  assertWorkerSqlAllowed: (...a: Parameters<typeof realAssert>) =>
    analyzerOff ? undefined : realAssert(...a),
}));

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  _resetExtensionDbRoleForTests,
  grantExtensionDbRole,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import {
  getCurrentTenantTrx,
  restrictTemporaryObjects,
  temporaryObjectsRestricted,
} from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const EXT = 'pooltempprobe';
const NON_OWNER = 'zz_pooltemp_nonowner';
const PROBE = `zz_pooltemp_${Date.now()}`;

d('ctx.db role windows leave no temp objects when TEMPORARY could not be revoked', () => {
  let db: Database;
  let ext: Database;
  /** Committed temp tables with this name in ANY session: pg_class shows every backend's. */
  const leftover = async (name: string) =>
    Number(
      (
        await sql<{ n: string }>`
          SELECT count(*) AS n FROM pg_class
           WHERE relname = ${name} AND relpersistence = 't'`.execute(db)
      ).rows[0]!.n,
    );
  const visible = async (h: Database, name: string) =>
    (
      await sql<{ r: string | null }>`SELECT to_regclass(${`pg_temp.${name}`})::text AS r`.execute(
        h,
      )
    ).rows[0]!.r;

  beforeAll(async () => {
    db = (await getTestApp()).db;
    // A database the engine does not own: TEMPORARY back on PUBLIC, and boot's
    // restrict run by a role that can neither grant nor revoke it.
    await sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sql.lit(NON_OWNER)}) THEN
        CREATE ROLE ${sql.id(NON_OWNER)} NOLOGIN;
      END IF; END $$`.execute(db);
    await sql`DO $$ BEGIN
      EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database()); END $$`.execute(
      db,
    );
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE ${sql.id(NON_OWNER)}`.execute(trx);
      await restrictTemporaryObjects(trx);
    });
    _resetExtensionDbRoleForTests();
    await grantExtensionDbRole(db, EXT, new Set());
    ext = createRestrictedDb(() => getCurrentTenantTrx() ?? db, EXT, new Set());
  }, 60_000);

  afterAll(async () => {
    analyzerOff = false;
    // Roles are cluster-wide and outlive this database.
    await revokeExtensionDbRoles(db, EXT, true);
    _resetExtensionDbRoleForTests();
    // Heal: boot as the owner takes TEMPORARY from PUBLIC again.
    await restrictTemporaryObjects(db);
    await sql`DROP ROLE IF EXISTS ${sql.id(NON_OWNER)}`.execute(db);
  });

  it('is the non-owner case: the restricted roles still hold TEMPORARY', () => {
    expect(temporaryObjectsRestricted()).toBe(false);
  });

  it('drops a temp table made in the request transaction before the engine runs again', async () => {
    analyzerOff = true;
    try {
      const name = `${PROBE}_trx`;
      const seen = await buildExtensionInternals().withTenantIsolation(TENANT, async () => {
        await sql`CREATE TEMP TABLE ${sql.id(name)} (id int)`.execute(ext);
        // The engine's next statement on the same transaction.
        return visible(getCurrentTenantTrx()!, name);
      });
      expect(seen).toBeNull();
      expect(await leftover(name)).toBe(0);
    } finally {
      analyzerOff = false;
    }
  }, 60_000);

  it('drops one made on the pool (ctx.adminDb) before the connection goes back', async () => {
    analyzerOff = true;
    try {
      await sql`CREATE TEMP TABLE ${sql.id(`${PROBE}_pool`)} (id int)`.execute(ext);
      expect(await leftover(`${PROBE}_pool`)).toBe(0);
      const name = `${PROBE}_admintrx`;
      const seen = await ext.transaction().execute(async (t) => {
        await sql`CREATE TEMP TABLE ${sql.id(name)} (id int)`.execute(t);
        // The next statement on that transaction's connection.
        return visible(t, name);
      });
      expect(seen).toBeNull();
      expect(await leftover(name)).toBe(0);
    } finally {
      analyzerOff = false;
    }
  }, 60_000);

  it('drops one made in the request transaction where no extension role is usable', async () => {
    // Degraded mode: ctx.db keeps the tenant role, with no role window around it.
    _resetExtensionDbRoleForTests();
    analyzerOff = true;
    try {
      const name = `${PROBE}_degraded`;
      const seen = await buildExtensionInternals().withTenantIsolation(TENANT, async () => {
        const who = await sql<{ r: string }>`SELECT current_user::text AS r`.execute(ext);
        expect(who.rows[0]!.r).toBe('zveltio_rls');
        await sql`CREATE TEMP TABLE ${sql.id(name)} (id int)`.execute(ext);
        return visible(getCurrentTenantTrx()!, name);
      });
      expect(seen).toBeNull();
      expect(await leftover(name)).toBe(0);
    } finally {
      analyzerOff = false;
      await grantExtensionDbRole(db, EXT, new Set());
    }
  }, 60_000);
});
