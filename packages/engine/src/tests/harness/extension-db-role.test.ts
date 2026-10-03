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
import type { Database } from '../../db/index.js';
import { engineHandle } from '../../lib/engine-handle.js';
import {
  _resetExtensionDbRoleForTests,
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

  it('leaves a transaction opened on the pool — ctx.adminDb.transaction() — on the engine role', async () => {
    // `db:admin` is the deliberate cross-tenant handle; the extension role is bound
    // by tenant RLS and would quietly narrow it to one tenant.
    const admin = createRestrictedDb(db, EXT, new Set([OWN]));
    expect(await admin.transaction().execute((t) => whoAmI(t))).not.toBe('zveltio_ext');
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
});
