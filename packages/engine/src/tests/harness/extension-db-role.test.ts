/**
 * An inline extension's `ctx.db` statement runs as `zveltio_ext` inside a tenant
 * transaction, so SQL the analyzer gets wrong still cannot reach the engine.
 *
 * The analyzer (`assertWorkerSqlAllowed`) was the only barrier: in a tenant
 * transaction `ctx.db` ran as `zveltio_rls`, which holds DML on every table in
 * `public` except the credential ones. Measured on master with the analyzer
 * switched off — the seam below — `SELECT … FROM zv_api_keys`, `FROM "user"` and
 * `INSERT INTO zvd_permissions` (a god grant) all succeeded, and one
 * `set_config('role', 'none', true)` left the REST of the request running as the
 * engine's login role (a superuser here).
 *
 * The seam: `assertWorkerSqlAllowed` is replaced by a pass-through to the real
 * one, which this file can switch off. Off, every statement reaches Postgres
 * exactly as an analyzer miss would; on — the default, and the state other files
 * see if the mock outlives this one — nothing differs from production.
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
import { createDb, type Database } from '../../db/index.js';
import { engineHandle } from '../../lib/engine-handle.js';
import {
  _resetExtensionDbRoleForTests,
  ensureExtensionDbRole,
  grantExtensionDbRole,
} from '../../lib/extensions/ext-db-role.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { applyTenantRLS, getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const EXT = 'roleprobe';
const OWN = 'zv_roleprobe_notes';
const GRANTED = 'zv_roleprobe_granted';
const COLLECTION = 'zvd_roleprobe_things';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000a2';
const PLAIN = 'pool_roleprobe_plain';

d('ctx.db runs as the extension role in a tenant transaction', () => {
  let db: Database;
  let ext: Database;
  const inTenant = <T>(fn: (trx: Database) => Promise<T>): Promise<T> =>
    buildExtensionInternals().withTenantIsolation(TENANT, () => fn(getCurrentTenantTrx()!));
  const whoAmI = async (h: Database) =>
    (await sql<{ r: string }>`SELECT current_user::text AS r`.execute(h)).rows[0]!.r;

  beforeAll(async () => {
    db = (await getTestApp()).db;
    await sql`CREATE TABLE IF NOT EXISTS ${sql.table(OWN)} (id serial PRIMARY KEY, note text)`.execute(
      db,
    );
    await sql`CREATE TABLE IF NOT EXISTS ${sql.table(GRANTED)} (id serial PRIMARY KEY, note text)`.execute(
      db,
    );
    await sql`CREATE TABLE IF NOT EXISTS ${sql.table(COLLECTION)} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text,
      tenant_id uuid NOT NULL DEFAULT ${sql.lit(TENANT)}::uuid)`.execute(db);
    const allowed = new Set([OWN, GRANTED]);
    _resetExtensionDbRoleForTests();
    // What `loadExtension` does after the extension's migrations.
    await grantExtensionDbRole(db, EXT, allowed);
    await applyTenantRLS(db, COLLECTION);
    ext = createRestrictedDb(() => getCurrentTenantTrx() ?? db, EXT, allowed);
  });

  afterAll(async () => {
    analyzerOff = false;
    // Module state: left ready, every later file's pool `ctx.db` would open a
    // transaction per statement — a stub Kysely in a unit test logs it.
    _resetExtensionDbRoleForTests();
    for (const t of [OWN, GRANTED, COLLECTION]) {
      await sql`DROP TABLE IF EXISTS ${sql.table(t)}`.execute(db);
    }
    await sql`DROP TABLE IF EXISTS zz_roleprobe_ddl`.execute(db);
  });

  it('runs extension statements as zveltio_ext and gives the engine its role back', async () => {
    await inTenant(async (trx) => {
      expect(await whoAmI(ext)).toBe('zveltio_ext');
      expect(await whoAmI(trx)).toBe('zveltio_rls');
      expect(await whoAmI(engineHandle(ext))).toBe('zveltio_rls');
    });
  }, 60_000);

  it('refuses engine tables and DDL to a statement the analyzer let through', async () => {
    analyzerOff = true;
    try {
      for (const stmt of [
        'SELECT count(*) FROM zv_api_keys',
        'SELECT count(*) FROM "user"',
        'SELECT count(*) FROM session',
        'SELECT count(*) FROM zv_tenants',
        `INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3) VALUES ('p', 'x', '*', '*', '*')`,
        'CREATE TABLE zz_roleprobe_ddl (id int)',
      ]) {
        const attempt = inTenant(() => sql.raw(stmt).execute(ext));
        await expect(attempt, stmt).rejects.toThrow(/permission denied/);
      }
    } finally {
      analyzerOff = false;
    }
  }, 60_000);

  it('keeps concurrent extension statements on one transaction from trading roles', async () => {
    // Extensions do `Promise.all([ctx.db…, ctx.db…])` on the request transaction.
    await inTenant(async (trx) => {
      const roles = await Promise.all(Array.from({ length: 12 }, () => whoAmI(ext)));
      expect(new Set(roles)).toEqual(new Set(['zveltio_ext']));
      expect(await whoAmI(trx)).toBe('zveltio_rls');
    });
  }, 60_000);

  it('lets an escaped role last one statement, not the rest of the request', async () => {
    analyzerOff = true;
    try {
      await inTenant(async (trx) => {
        await sql`SELECT set_config('role', 'none', true)`.execute(ext);
        expect(await whoAmI(trx)).toBe('zveltio_rls');
        expect(await whoAmI(ext)).toBe('zveltio_ext');
      });
    } finally {
      analyzerOff = false;
    }
  }, 60_000);

  it('still reaches its own tables, a granted table and a collection', async () => {
    await inTenant(async () => {
      await sql`INSERT INTO ${sql.table(OWN)} (note) VALUES ('own')`.execute(ext);
      await sql`INSERT INTO ${sql.table(GRANTED)} (note) VALUES ('granted')`.execute(ext);
      await ext
        .insertInto(COLLECTION as never)
        .values({ note: 'row' } as never)
        .execute();
      const r = await sql<{ n: number }>`
        SELECT (SELECT count(*) FROM ${sql.table(OWN)})::int
             + (SELECT count(*) FROM ${sql.table(GRANTED)})::int
             + (SELECT count(*) FROM ${sql.table(COLLECTION)})::int AS n`.execute(ext);
      expect(r.rows[0]!.n).toBe(3);
    });
  }, 60_000);

  it('runs ctx.db.transaction() as the role, and a throw inside it restores the engine role', async () => {
    await inTenant(async (trx) => {
      const inner = await ext.transaction().execute((t) => whoAmI(t));
      expect(inner).toBe('zveltio_ext');
      await expect(
        ext.transaction().execute(async (t) => {
          await sql`SELECT 1/0`.execute(t);
        }),
      ).rejects.toThrow(/division by zero/);
      expect(await whoAmI(trx)).toBe('zveltio_rls');
    });
  }, 60_000);

  // ── The pool: boot, cron, listeners, background work, and `ctx.adminDb` ──
  //
  // Measured on master with the analyzer off: every statement below ran as the
  // engine's login role (`postgres` here) and read "user", session and
  // zv_api_keys, wrote a god grant and created a table.

  /** `ctx.db` outside any tenant transaction, and `ctx.adminDb`: both the pool. */
  const onPool = () => [
    createRestrictedDb(() => getCurrentTenantTrx() ?? db, EXT, new Set([OWN, GRANTED])),
    createRestrictedDb(db, EXT, new Set([OWN, GRANTED])),
  ];
  const tenantsSeen = async (h: Database) =>
    (
      await sql<{ n: number }>`
        SELECT count(DISTINCT tenant_id)::int AS n FROM ${sql.table(COLLECTION)}`.execute(h)
    ).rows[0]!.n;

  it('runs a pool statement as the RLS-bypassing twin on a superuser engine, engine helpers on the engine role', async () => {
    for (const h of onPool()) {
      expect(await whoAmI(h)).toBe('zveltio_ext_bypass');
      expect(await whoAmI(engineHandle(h))).toBe('postgres');
    }
    const admin = onPool()[1]!;
    expect(await admin.transaction().execute((t) => whoAmI(t))).toBe('zveltio_ext_bypass');
    expect(await admin.transaction().execute((t) => whoAmI(engineHandle(t)))).toBe('postgres');
  }, 60_000);

  it('refuses engine tables and DDL to a pool statement the analyzer let through', async () => {
    analyzerOff = true;
    try {
      for (const h of onPool()) {
        for (const stmt of [
          'SELECT count(*) FROM zv_api_keys',
          'SELECT count(*) FROM "user"',
          'SELECT count(*) FROM session',
          `INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3) VALUES ('p', 'x', '*', '*', '*')`,
          'CREATE TABLE zz_roleprobe_ddl (id int)',
        ]) {
          await expect(sql.raw(stmt).execute(h), stmt).rejects.toThrow(/permission denied/);
          await expect(
            h.transaction().execute((t) => sql.raw(stmt).execute(t)),
            `in a transaction: ${stmt}`,
          ).rejects.toThrow(/permission denied/);
        }
      }
    } finally {
      analyzerOff = false;
    }
  }, 60_000);

  it('keeps the cross-tenant reach a superuser engine had on the pool', async () => {
    await sql`DELETE FROM ${sql.table(COLLECTION)}`.execute(db);
    await sql`INSERT INTO ${sql.table(COLLECTION)} (note, tenant_id)
              VALUES ('a', ${TENANT}::uuid), ('b', ${OTHER_TENANT}::uuid)`.execute(db);
    expect(await tenantsSeen(db)).toBe(2);
    for (const h of onPool()) {
      expect(await tenantsSeen(h)).toBe(2);
      expect(await h.transaction().execute((t) => tenantsSeen(t))).toBe(2);
    }
  }, 60_000);

  it('lets an escaped role last one pool statement', async () => {
    analyzerOff = true;
    try {
      const [h, admin] = onPool();
      await sql`SELECT set_config('role', 'none', true)`.execute(h!);
      expect(await whoAmI(h!)).toBe('zveltio_ext_bypass');
      await admin!.transaction().execute(async (t) => {
        await sql`SELECT set_config('role', 'none', true)`.execute(t);
        expect(await whoAmI(t)).toBe('zveltio_ext_bypass');
      });
    } finally {
      analyzerOff = false;
    }
  }, 60_000);

  it('runs pool statements as zveltio_ext on a plain-role engine, seeing what the engine sees', async () => {
    await sql.raw(`DROP ROLE IF EXISTS ${PLAIN}`).execute(db);
    await sql.raw(`CREATE ROLE ${PLAIN} LOGIN PASSWORD 'p' NOSUPERUSER NOBYPASSRLS`).execute(db);
    // What scripts/bootstrap-db-role.sh gives the engine role.
    await sql.raw(`GRANT zveltio_ext TO ${PLAIN}`).execute(db);
    await sql.raw(`GRANT SELECT ON ${COLLECTION} TO ${PLAIN}`).execute(db);
    const url = new URL(String(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL));
    url.username = PLAIN;
    url.password = 'p';
    const plain = createDb(url.toString());
    try {
      _resetExtensionDbRoleForTests();
      expect(await ensureExtensionDbRole(plain)).toBe(true);
      const ext = createRestrictedDb(plain, EXT, new Set([OWN]));
      expect(await whoAmI(ext)).toBe('zveltio_ext');
      expect(await ext.transaction().execute((t) => whoAmI(t))).toBe('zveltio_ext');
      const engineSees = await tenantsSeen(plain);
      expect(engineSees).toBeLessThan(2); // RLS binds the plain role on the pool
      expect(await tenantsSeen(ext)).toBe(engineSees);
      // The twin is never handed to a role that RLS binds.
      const m = await sql<{ m: boolean }>`
        SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_ext_bypass')
           AND pg_has_role(${PLAIN}, 'zveltio_ext_bypass', 'MEMBER') AS m`.execute(db);
      expect(m.rows[0]!.m).toBe(false);
    } finally {
      await plain.destroy().catch(() => {});
      _resetExtensionDbRoleForTests();
      await ensureExtensionDbRole(db);
      await sql.raw(`REVOKE ALL ON ${COLLECTION} FROM ${PLAIN}`).execute(db);
      await sql.raw(`DROP ROLE IF EXISTS ${PLAIN}`).execute(db);
    }
  }, 60_000);

  it('makes ctx.db.transaction().setAccessMode("read only") read-only inside a joined transaction', async () => {
    await inTenant(async (trx) => {
      await expect(
        ext
          .transaction()
          .setAccessMode('read only')
          .execute((t) => sql`INSERT INTO ${sql.table(OWN)} (note) VALUES ('ro')`.execute(t)),
      ).rejects.toThrow(/read-only transaction/);
      // Reads still run, and the request's transaction is writable afterwards.
      expect(
        await ext
          .transaction()
          .setAccessMode('read only')
          .execute((t) => whoAmI(t)),
      ).toBe('zveltio_ext');
      const ro = await sql<{
        v: string;
      }>`SELECT current_setting('transaction_read_only') AS v`.execute(trx);
      expect(ro.rows[0]!.v).toBe('off');
      await sql`INSERT INTO ${sql.table(OWN)} (note) VALUES ('rw')`.execute(ext);
    });
  }, 60_000);
});
