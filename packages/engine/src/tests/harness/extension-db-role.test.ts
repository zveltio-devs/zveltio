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
  extensionDbRoleNames,
  grantExtensionDbRole,
  grantWorkerDbRole,
} from '../../lib/extensions/ext-db-role.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import {
  applyTenantRLS,
  getCurrentTenantTrx,
  restrictTemporaryObjects,
} from '../../lib/tenancy/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  ALL_COLLECTIONS_ACTOR,
  createGodSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

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
  /** The extension's own role and its BYPASSRLS twin (this engine is a superuser). */
  let ROLE = '';
  let TWIN = '';
  const inTenant = <T>(fn: (trx: Database) => Promise<T>): Promise<T> =>
    withTenantIsolation(TENANT, () => fn(getCurrentTenantTrx()!), {
      identity: ALL_COLLECTIONS_ACTOR,
    });
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
    const dbName = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!
      .d;
    ({ role: ROLE, bypass: TWIN } = extensionDbRoleNames(dbName, EXT));
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

  it('runs extension statements as the extension\u2019s own role and gives the engine its role back', async () => {
    await inTenant(async (trx) => {
      expect(await whoAmI(ext)).toBe(ROLE);
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
      expect(new Set(roles)).toEqual(new Set([ROLE]));
      expect(await whoAmI(trx)).toBe('zveltio_rls');
    });
  }, 60_000);

  it('lets an escaped role last one statement, not the rest of the request', async () => {
    analyzerOff = true;
    try {
      await inTenant(async (trx) => {
        await sql`SELECT set_config('role', 'none', true)`.execute(ext);
        expect(await whoAmI(trx)).toBe('zveltio_rls');
        expect(await whoAmI(ext)).toBe(ROLE);
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
      expect(inner).toBe(ROLE);
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
      expect(await whoAmI(h)).toBe(TWIN);
      expect(await whoAmI(engineHandle(h))).toBe('postgres');
    }
    const admin = onPool()[1]!;
    expect(await admin.transaction().execute((t) => whoAmI(t))).toBe(TWIN);
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
      expect(await whoAmI(h!)).toBe(TWIN);
      await admin!.transaction().execute(async (t) => {
        await sql`SELECT set_config('role', 'none', true)`.execute(t);
        expect(await whoAmI(t)).toBe(TWIN);
      });
    } finally {
      analyzerOff = false;
    }
  }, 60_000);

  it('runs pool statements as zveltio_ext on a plain-role engine (no CREATEROLE: shared role), and with no actor reads no collection rows', async () => {
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
      // Collection permissions (R1): an extension's statement with no actor —
      // the pool, outside any request — gets nothing from a collection, where
      // the engine's own statement still sees its default tenant.
      expect(engineSees).toBe(1);
      expect(await tenantsSeen(ext)).toBe(0);
      // The twin is never handed to a role that RLS binds.
      const m = await sql<{ m: boolean }>`
        SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_ext_bypass')
           AND pg_has_role(${PLAIN}, 'zveltio_ext_bypass', 'MEMBER') AS m`.execute(db);
      expect(m.rows[0]!.m).toBe(false);
    } finally {
      await plain.destroy().catch(() => {});
      _resetExtensionDbRoleForTests();
      await grantExtensionDbRole(db, EXT, new Set([OWN, GRANTED]));
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
      ).toBe(ROLE);
      const ro = await sql<{
        v: string;
      }>`SELECT current_setting('transaction_read_only') AS v`.execute(trx);
      expect(ro.rows[0]!.v).toBe('off');
      await sql`INSERT INTO ${sql.table(OWN)} (note) VALUES ('rw')`.execute(ext);
    });
  }, 60_000);
});

// ── Separation between extensions ───────────────────────────────────────────
//
// One shared `zveltio_ext` held every inline extension's tables (and one
// `zveltio_worker` every worker extension's), so with the analyzer switched off
// extension A read extension B's tables; `a` reached `zv_a_b_*`, the tables of
// `a/b`; and disable/uninstall revoked nothing. Measured on master: each case
// below that expects `permission denied` or an empty grant list got rows.

const A = 'sepa';
const A_OWN = 'zv_sepa_notes';
const B = 'sepb';
const B_OWN = 'zv_sepb_notes';
const PFX = 'pfx';
const PFX_OWN = 'zv_pfx_items';
const SUB = 'pfx/sub';
const SUB_OWN = 'zv_pfx_sub_items';
const LATE = 'pfy';
const LATE_SUB = 'pfy/sub';
const LATE_SUB_OWN = 'zv_pfy_sub_items';
const LIFE = 'lifeprobe';
const LIFE_OWN = 'zv_lifeprobe_items';
const SEP_TABLES = [A_OWN, B_OWN, PFX_OWN, SUB_OWN, LATE_SUB_OWN, LIFE_OWN];
/** Every role these tests can make, in any database of the cluster. */
const SEP_ROLES =
  '^zveltio_(ext|extb|wrk)_(sepa|sepb|pfx|pfx_sub|pfy|pfy_sub|lifeprobe|roleprobe)_';

d('one extension cannot reach another extension’s tables at the database layer', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof getTestApp>>['app'];
  let cookie: string;
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    withTenantIsolation(TENANT, fn, { identity: ALL_COLLECTIONS_ACTOR });
  const extDb = (name: string, allowed: string[] = []) =>
    createRestrictedDb(() => getCurrentTenantTrx() ?? db, name, new Set(allowed));
  const count = (h: Database, table: string) =>
    sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(h);
  /** Fails with the database's refusal (or the analyzer's), in a tenant transaction and on the pool. */
  const refusedBoth = async (h: Database, table: string, why: RegExp) => {
    await expect(inTenant(() => count(h, table))).rejects.toThrow(why);
    await expect(count(h, table)).rejects.toThrow(why);
  };
  const offAnalyzer = async (fn: () => Promise<void>) => {
    analyzerOff = true;
    try {
      await fn();
    } finally {
      analyzerOff = false;
    }
  };
  const post = (path: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{}',
    });
  /** Extension and worker roles (shared or LIFE's own) that hold anything on LIFE_OWN or its sequence. */
  const lifeGrantees = async () =>
    (
      await sql<{ r: string }>`
        SELECT DISTINCT r.rolname::text AS r
          FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
         WHERE c.relname IN (${LIFE_OWN}, ${`${LIFE_OWN}_id_seq`})
           AND r.rolname ~ '^zveltio_(ext|extb|wrk|worker)' ORDER BY 1`.execute(db)
    ).rows.map((x) => x.r);
  /** LIFE's own roles, and whatever each still holds: relations in public and memberships. */
  const lifeRoles = async () =>
    (
      await sql<{ r: string; rels: number; parents: number }>`
        SELECT r.rolname::text AS r,
               (SELECT count(*)::int FROM pg_class c, aclexplode(c.relacl) a
                 WHERE a.grantee = r.oid) AS rels,
               (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS parents
          FROM pg_roles r WHERE r.rolname ~ '^zveltio_(ext|extb|wrk)_lifeprobe_' ORDER BY 1`.execute(
        db,
      )
    ).rows;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    for (const t of SEP_TABLES) {
      await sql`CREATE TABLE IF NOT EXISTS ${sql.table(t)} (id serial PRIMARY KEY, note text)`.execute(
        db,
      );
      await sql`INSERT INTO ${sql.table(t)} (note) VALUES ('x')`.execute(db);
    }
    _resetExtensionDbRoleForTests();
    // What `loadExtension` does after each extension's migrations.
    await grantExtensionDbRole(db, A, new Set([A_OWN]));
    await grantExtensionDbRole(db, B, new Set([B_OWN]));
    // `a/b` installed after `a`, the order a marketplace install produces.
    await grantExtensionDbRole(db, PFX, new Set());
    await grantExtensionDbRole(db, SUB, new Set());
  }, 60_000);

  afterAll(async () => {
    analyzerOff = false;
    _resetExtensionDbRoleForTests();
    for (const t of SEP_TABLES) await sql`DROP TABLE IF EXISTS ${sql.table(t)}`.execute(db);
    await sql`DROP TABLE IF EXISTS zv_sepa_late`.execute(db);
    await db.deleteFrom('zv_extension_registry').where('name', '=', LIFE).execute();
    // Roles are cluster-wide and outlive this database.
    const roles = await sql<{ r: string }>`
      SELECT rolname::text AS r FROM pg_roles WHERE rolname ~ ${SEP_ROLES}
      ORDER BY rolname ~ '^zveltio_extb_' DESC`.execute(db);
    for (const { r } of roles.rows) {
      await sql`DROP OWNED BY ${sql.id(r)}`.execute(db);
      await sql`DROP ROLE IF EXISTS ${sql.id(r)}`.execute(db);
    }
    await ensureExtensionDbRole(db);
  });

  it('refuses extension A the tables of extension B when the analyzer lets the statement through', async () => {
    const a = extDb(A, [A_OWN]);
    await offAnalyzer(async () => {
      await refusedBoth(a, B_OWN, /permission denied/);
      // Not a role that reaches nothing: A's own table answers.
      expect((await inTenant(() => count(a, A_OWN))).rows[0]!.n).toBe(1);
      expect((await count(a, A_OWN)).rows[0]!.n).toBe(1);
    });
  }, 60_000);

  it('gives the tables of `a/b` to `a/b`, not to `a`, in the analyzer and in the database', async () => {
    const pfx = extDb(PFX);
    await refusedBoth(pfx, SUB_OWN, /attempted to access zv_pfx_sub_items/);
    await offAnalyzer(() => refusedBoth(pfx, SUB_OWN, /permission denied/));
    expect((await count(pfx, PFX_OWN)).rows[0]!.n).toBe(1);
    expect((await inTenant(() => count(extDb(SUB), SUB_OWN))).rows[0]!.n).toBe(1);
  }, 60_000);

  it('takes `a/b`’s tables back from `a` when `a/b` arrives after `a` already holds them', async () => {
    // `pfy/sub`'s table exists, unknown to this process, when `pfy` is granted —
    // an install from before, or another replica's.
    await grantExtensionDbRole(db, LATE, new Set());
    await grantExtensionDbRole(db, LATE_SUB, new Set());
    await offAnalyzer(() => refusedBoth(extDb(LATE), LATE_SUB_OWN, /permission denied/));
    expect((await count(extDb(LATE_SUB), LATE_SUB_OWN)).rows[0]!.n).toBe(1);
  }, 60_000);

  it('leaves a disabled extension’s roles holding nothing, gives them back on enable, drops them on uninstall', async () => {
    const allowed = new Set([LIFE_OWN]);
    await grantExtensionDbRole(db, LIFE, allowed);
    await grantWorkerDbRole(db, LIFE, allowed);
    const life = extDb(LIFE, [LIFE_OWN]);
    expect((await count(life, LIFE_OWN)).rows[0]!.n).toBe(1);

    const off = await post(`/api/marketplace/${LIFE}/disable`);
    expect(off.status).toBe(200);
    expect(await lifeGrantees()).toEqual([]);
    for (const r of await lifeRoles()) expect(r, r.r).toEqual({ r: r.r, rels: 0, parents: 0 });
    // Code of the disabled extension still running (a timer its cleanup missed).
    await offAnalyzer(() => refusedBoth(life, LIFE_OWN, /permission denied/));

    // Enable runs the load again, which grants again.
    await grantExtensionDbRole(db, LIFE, allowed);
    expect((await inTenant(() => count(life, LIFE_OWN))).rows[0]!.n).toBe(1);

    const gone = await post(`/api/marketplace/${LIFE}/uninstall`);
    expect(gone.status).toBe(200);
    expect(await lifeGrantees()).toEqual([]);
    expect(await lifeRoles()).toEqual([]);
  }, 60_000);

  it('takes off the shared roles what they held before per-extension roles, disabled extensions\u2019 tables included', async () => {
    // An install upgraded from the shared layout: B's table sits on both shared roles.
    await sql`GRANT SELECT ON ${sql.table(B_OWN)} TO zveltio_ext, zveltio_worker`.execute(db);
    _resetExtensionDbRoleForTests();
    // Any extension's load, not B's: B may be disabled and never load again.
    await grantExtensionDbRole(db, A, new Set([A_OWN]));
    await grantWorkerDbRole(db, A, new Set([A_OWN]));
    const shared = await sql<{ r: string }>`
      SELECT r.rolname::text AS r FROM pg_class c, aclexplode(c.relacl) a
        JOIN pg_roles r ON r.oid = a.grantee
       WHERE c.relname = ${B_OWN} AND r.rolname IN ('zveltio_ext', 'zveltio_worker')`.execute(db);
    expect(shared.rows).toEqual([]);
    await offAnalyzer(() => refusedBoth(extDb(A, [A_OWN]), B_OWN, /permission denied/));
  }, 60_000);

  it('gives an extension role no CREATE on the schema and no TEMPORARY, so it makes no table at runtime', async () => {
    await offAnalyzer(async () => {
      const a = extDb(A, [A_OWN]);
      for (const stmt of [
        'CREATE TABLE zv_sepa_late (id int)',
        'CREATE TEMP TABLE zz_sepa_tmp (id int)',
      ]) {
        await expect(
          inTenant(() => sql.raw(stmt).execute(a)),
          stmt,
        ).rejects.toThrow(/permission denied/);
      }
    });
    expect(await restrictTemporaryObjects(db)).toBe(true);
  }, 60_000);
});
