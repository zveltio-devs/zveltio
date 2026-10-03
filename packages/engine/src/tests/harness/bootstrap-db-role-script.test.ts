/**
 * The install scripts/bootstrap-db-role.sh builds gives each extension a
 * database role of its own, and the CREATEROLE that takes reaches nothing else.
 *
 * The script made the engine role NOCREATEROLE and granted zveltio_ext /
 * zveltio_worker without ADMIN, so `canMakeRolesUnder` answered false and every
 * extension of a hardened install shared one role: extension A reached extension
 * B's tables at the database layer, the SQL analyzer the only thing between them.
 * Measured on master with this file: `ctx.db` ran as `zveltio_ext`, not as the
 * extension's own role.
 *
 * And the install could not migrate at all: migration 032's function `SET
 * zveltio.current_tenant` clause failed with "permission denied to set parameter"
 * — Postgres treats a custom placeholder in a function SET clause or in
 * ALTER DATABASE … SET as superuser-only unless SET on it was granted. Boot's
 * fail-closed GUC (ALTER DATABASE … RESET zveltio.fail_closed_tenant) failed the
 * same way, and 001's database default for zveltio.current_tenant was skipped
 * with a NOTICE.
 *
 * The REAL script runs here, twice (it must stay idempotent), against a scratch
 * database; the real migration runner and a real engine boot then run as the
 * role it made, and the engine code after them.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import {
  _resetExtensionDbRoleForTests,
  ensureExtensionDbRole,
  extensionDbRoleNames,
  grantExtensionDbRole,
  grantWorkerDbRole,
  revokeExtensionDbRoles,
  workerDbRoleFor,
} from '../../lib/extensions/ext-db-role.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { applyFailClosedTenantSetting } from '../../lib/tenancy/fail-closed-tenant.js';
import { harnessAvailable } from '../../testing/app-harness.js';

const SCRIPT = join(import.meta.dir, '../../../../../scripts/bootstrap-db-role.sh');
const ENGINE = join(import.meta.dir, '../../..');
/** What a privilege the install did not grant prints, wherever it is caught. */
const PRIVILEGE_ERROR =
  /permission denied|must be owner|superuser required|insufficient privilege/i;
const EXT = 'bootprobe';
const OWN = 'zv_bootprobe_notes';

const d = harnessAvailable() ? describe : describe.skip;

d('scripts/bootstrap-db-role.sh: per-extension roles on a hardened install', () => {
  const superUrl = new URL(String(process.env.TEST_DATABASE_URL));
  // Roles are cluster-wide: keyed to this harness database so parallel runs on
  // one cluster do not share them.
  const key = createHash('sha256').update(superUrl.pathname).digest('hex').slice(0, 8);
  const DB = `zz_bootrole_${key}`;
  const APP = `zz_bootrole_app_${key}`;
  const PLAIN = `zz_bootrole_plain_${key}`;
  const MADE = `zz_bootrole_made_${key}`;
  const PASS = "pa'ss";
  let sup: Database;
  let app: Database;

  const urlFor = (user: string, pass: string, db = DB) => {
    const u = new URL(superUrl);
    u.username = user;
    u.password = encodeURIComponent(pass);
    u.pathname = `/${db}`;
    return u.toString();
  };
  const runScript = () => {
    const r = Bun.spawnSync(['bash', SCRIPT, DB, APP, PASS], {
      env: {
        ...process.env,
        PGHOST: superUrl.hostname,
        PGPORT: superUrl.port || '5432',
        PGUSER: decodeURIComponent(superUrl.username),
        PGPASSWORD: decodeURIComponent(superUrl.password),
      },
    });
    if (r.exitCode !== 0) throw new Error(`bootstrap-db-role.sh failed: ${r.stderr.toString()}`);
    return r.stdout.toString();
  };
  /** Run `args` in the engine package as the script's role; all output, merged. */
  const engineProcess = async (args: string[], until?: RegExp, timeoutMs = 90_000) => {
    const p = Bun.spawn(['bun', ...args], {
      cwd: ENGINE,
      env: {
        ...process.env,
        DATABASE_URL: urlFor(APP, PASS),
        PORT: '0',
        BETTER_AUTH_SECRET:
          process.env.BETTER_AUTH_SECRET || 'bootrole-test-secret-0123456789abcdef',
        ZVELTIO_FAIL_CLOSED_TENANT: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let out = '';
    let ready = false;
    const pump = async (s: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const chunk of s) {
        out += dec.decode(chunk);
        if (until && !ready && until.test(out)) {
          ready = true;
          // Background boot work logs after the banner; give it a moment.
          setTimeout(() => p.kill(), 3_000);
        }
      }
    };
    const timer = setTimeout(() => p.kill(), timeoutMs);
    await Promise.all([pump(p.stdout), pump(p.stderr), p.exited]);
    clearTimeout(timer);
    return { out, code: p.exitCode, ready };
  };
  const dbSetting = async (name: string) =>
    (
      await sql<{ s: string }>`
        SELECT s FROM pg_db_role_setting r JOIN pg_database d ON d.oid = r.setdatabase,
               unnest(r.setconfig) s
         WHERE d.datname = ${DB} AND r.setrole = 0 AND s LIKE ${`${name}=%`}`.execute(sup)
    ).rows[0]?.s ?? null;
  const whoAmI = async (h: Database) =>
    (await sql<{ r: string }>`SELECT current_user::text AS r`.execute(h)).rows[0]!.r;

  beforeAll(async () => {
    sup = createDb(superUrl.toString());
    runScript();
    runScript(); // idempotent
    app = createDb(urlFor(APP, PASS));
    // An extension migration's table, created as the engine role (its owner).
    await sql`CREATE TABLE ${sql.table(OWN)} (id serial PRIMARY KEY, note text)`.execute(app);
    await sql`INSERT INTO ${sql.table(OWN)} (note) VALUES ('x')`.execute(app);
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await revokeExtensionDbRoles(app, EXT, true);
      await app.destroy().catch(() => {});
    }
    _resetExtensionDbRoleForTests();
    // Roles the engine created as APP (a CREATEROLE creator holds ADMIN on each),
    // e.g. per-extension roles of whatever the boot loaded.
    const made = await sql<{ r: string }>`
      SELECT r.rolname::text AS r FROM pg_auth_members m
        JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles a ON a.oid = m.member
       WHERE a.rolname = ${APP} AND m.admin_option
         AND r.rolname ~ '^zveltio_(ext|extb|wrk)_'
       ORDER BY r.rolname ~ '^zveltio_extb_' DESC`.execute(sup);
    await sql.raw(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).execute(sup);
    for (const { r } of made.rows) await sql`DROP ROLE IF EXISTS ${sql.id(r)}`.execute(sup);
    for (const r of [MADE, PLAIN, APP]) {
      const exists = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${r}`.execute(sup);
      // Its SET grants on parameters are shared objects: DROP ROLE refuses them.
      if (exists.rows.length) await sql.raw(`DROP OWNED BY ${r}`).execute(sup);
      await sql.raw(`DROP ROLE IF EXISTS ${r}`).execute(sup);
    }
    await sup.destroy().catch(() => {});
  }, 60_000);

  it('migrates and boots as the script’s role without a privilege error', async () => {
    const migrate = await engineProcess(['src/db/migrate.ts']);
    expect(migrate.out.match(PRIVILEGE_ERROR)?.[0] ?? null, migrate.out.slice(-2000)).toBeNull();
    expect(migrate.code).toBe(0);
    // 001's database default, which a refusal only reported as a NOTICE.
    expect(await dbSetting('zveltio.current_tenant')).toBe('zveltio.current_tenant=');

    const boot = await engineProcess(['src/index.ts'], /Zveltio running at/);
    const denied = boot.out.split('\n').filter((l) => PRIVILEGE_ERROR.test(l));
    expect(denied, boot.out.slice(-3000)).toEqual([]);
    expect(boot.ready, boot.out.slice(-3000)).toBe(true);

    // ZVELTIO_FAIL_CLOSED_TENANT=1 is fatal when it cannot be applied.
    const prev = process.env.ZVELTIO_FAIL_CLOSED_TENANT;
    const own = createDb(urlFor(APP, PASS));
    try {
      process.env.ZVELTIO_FAIL_CLOSED_TENANT = '1';
      await applyFailClosedTenantSetting(own);
      expect(await dbSetting('zveltio.fail_closed_tenant')).toBe('zveltio.fail_closed_tenant=on');
      process.env.ZVELTIO_FAIL_CLOSED_TENANT = '';
      await applyFailClosedTenantSetting(own);
      expect(await dbSetting('zveltio.fail_closed_tenant')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.ZVELTIO_FAIL_CLOSED_TENANT;
      else process.env.ZVELTIO_FAIL_CLOSED_TENANT = prev;
      await own.destroy().catch(() => {});
    }
  }, 240_000);

  it('runs an extension’s ctx.db and worker bridge as its own role', async () => {
    const names = extensionDbRoleNames(DB, EXT);
    _resetExtensionDbRoleForTests();
    await grantExtensionDbRole(app, EXT, new Set([OWN]));
    await grantWorkerDbRole(app, EXT, new Set([OWN]));
    const ext = createRestrictedDb(app, EXT, new Set([OWN]));
    expect(await whoAmI(ext)).toBe(names.role);
    const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(OWN)}`.execute(
      ext,
    );
    expect(n.rows[0]!.n).toBe(1);
    expect(workerDbRoleFor(EXT)).toBe(names.worker);
  }, 60_000);

  it('gives the engine role CREATEROLE that reaches no role it was not handed ADMIN on', async () => {
    const attrs = await sql<{ c: boolean; s: boolean; b: boolean; d: boolean }>`
      SELECT rolcreaterole AS c, rolsuper AS s, rolbypassrls AS b, rolcreatedb AS d
        FROM pg_roles WHERE rolname = ${APP}`.execute(sup);
    expect(attrs.rows[0]).toEqual({ c: true, s: false, b: false, d: false });
    // What it may do: make a role and put it under zveltio_ext.
    await sql.raw(`CREATE ROLE ${MADE} NOLOGIN`).execute(app);
    await sql.raw(`GRANT zveltio_ext TO ${MADE}`).execute(app);
    const superUser = decodeURIComponent(superUrl.username);
    for (const stmt of [
      `GRANT zveltio_rls TO ${MADE}`,
      `GRANT zveltio_flow_reader TO ${MADE}`,
      `GRANT zveltio_rls TO ${APP} WITH ADMIN OPTION`,
      `GRANT pg_read_all_data TO ${APP}`,
      `GRANT pg_write_all_data TO ${MADE}`,
      `GRANT pg_execute_server_program TO ${APP}`,
      `GRANT pg_read_server_files TO ${MADE}`,
      `ALTER ROLE ${APP} BYPASSRLS`,
      `ALTER ROLE ${APP} SUPERUSER`,
      `ALTER ROLE ${APP} CREATEDB`,
      `ALTER ROLE ${MADE} BYPASSRLS`,
      `CREATE ROLE ${MADE}_x SUPERUSER`,
      `CREATE ROLE ${MADE}_x BYPASSRLS`,
      `CREATE ROLE ${MADE}_x REPLICATION`,
      `CREATE ROLE ${MADE}_x CREATEDB`,
      `CREATE ROLE ${MADE}_x IN ROLE zveltio_rls`,
      `DROP ROLE zveltio_rls`,
      `ALTER ROLE zveltio_rls LOGIN`,
      `ALTER ROLE ${superUser} PASSWORD 'x'`,
    ]) {
      await expect(sql.raw(stmt).execute(app), stmt).rejects.toThrow(/permission denied/);
    }
    await sql.raw(`DROP ROLE ${MADE}`).execute(app);
  }, 60_000);

  it('says once at boot that extensions share one role where the engine cannot make roles', async () => {
    // The posture below 16, and of an install bootstrapped before this change.
    await sql.raw(`DROP ROLE IF EXISTS ${PLAIN}`).execute(sup);
    await sql
      .raw(`CREATE ROLE ${PLAIN} LOGIN PASSWORD 'p' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`)
      .execute(sup);
    await sql.raw(`GRANT zveltio_ext TO ${PLAIN}`).execute(sup);
    const plain = createDb(urlFor(PLAIN, 'p'));
    const warn = spyOn(console, 'warn');
    try {
      _resetExtensionDbRoleForTests();
      expect(await ensureExtensionDbRole(plain)).toBe(true);
      // An extension with no tables: the plain role owns none of the scratch ones.
      await grantExtensionDbRole(plain, 'plainprobe', new Set());
      expect(await whoAmI(createRestrictedDb(plain, 'plainprobe', new Set()))).toBe('zveltio_ext');
      const said = warn.mock.calls.filter((c) => /share one database role/.test(String(c[0])));
      expect(said.length).toBe(1);
    } finally {
      warn.mockRestore();
      await plain.destroy().catch(() => {});
      _resetExtensionDbRoleForTests();
    }
  }, 60_000);
});
