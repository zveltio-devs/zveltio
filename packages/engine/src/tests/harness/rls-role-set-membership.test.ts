/**
 * Boot reports tenant RLS "enforced" only when `SET LOCAL ROLE zveltio_rls`
 * will actually work.
 *
 * It tested membership with `pg_has_role(…, 'MEMBER')`. On Postgres an
 * engine role with CREATEROLE that creates `zveltio_rls` itself (migration 001
 * does, on such an install) holds it WITH ADMIN but SET FALSE: MEMBER answers
 * true, boot said "enforced", and every tenant request then failed on
 * `SET LOCAL ROLE` with "permission denied to set role". Both states are built
 * here with a superuser grant, since the cluster's `zveltio_rls` already exists.
 *
 * Same gap for the two narrow roles: boot granted no SET on `zveltio_worker` or
 * `zveltio_flow_reader`, and the worker SQL bridge picked its role by EXISTENCE,
 * so a SET FALSE membership failed every worker query on `SET LOCAL ROLE`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import { initRlsEnforcementRole } from '../../lib/tenancy/index.js';
import { pickWorkerSqlRole } from '../../lib/worker-extension-host.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ADMIN_ONLY = 'pool_rlsrole_admin'; // what CREATE ROLE leaves its CREATEROLE creator
const NO_SET = 'pool_rlsrole_noset'; // a member that may neither SET nor re-grant
const NARROW = ['zveltio_worker', 'zveltio_flow_reader'];

d('zveltio_rls membership is tested with SET, not MEMBER', () => {
  let db: Database;
  const opened: Database[] = [];
  const connectAs = (role: string) => {
    const url = new URL(String(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL));
    url.username = role;
    url.password = 'p';
    const h = createDb(url.toString());
    opened.push(h);
    return h;
  };
  const dropRoles = async () => {
    for (const r of [ADMIN_ONLY, NO_SET]) {
      await sql
        .raw(`DROP OWNED BY ${r}`)
        .execute(db)
        .catch(() => {});
      await sql.raw(`DROP ROLE IF EXISTS ${r}`).execute(db);
    }
  };

  beforeAll(async () => {
    db = (await getTestApp()).db;
    await dropRoles();
    for (const r of [ADMIN_ONLY, NO_SET]) {
      await sql
        .raw(`CREATE ROLE ${r} LOGIN PASSWORD 'p' CREATEROLE NOSUPERUSER NOBYPASSRLS`)
        .execute(db);
    }
    for (const role of ['zveltio_rls', ...NARROW]) {
      await sql
        .raw(`GRANT ${role} TO ${ADMIN_ONLY} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`)
        .execute(db);
      await sql.raw(`GRANT ${role} TO ${NO_SET} WITH INHERIT FALSE, SET FALSE`).execute(db);
    }
  });

  afterAll(async () => {
    for (const h of opened) await h.destroy().catch(() => {});
    await initRlsEnforcementRole(db); // module state back to the harness engine's
    await dropRoles();
  });

  it('grants itself SET where it holds ADMIN, and the role then switches', async () => {
    const h = connectAs(ADMIN_ONLY);
    expect(await initRlsEnforcementRole(h)).toBe('enforced');
    await h.transaction().execute(async (t) => {
      await sql`SET LOCAL ROLE zveltio_rls`.execute(t);
      const r = await sql<{ u: string }>`SELECT current_user::text AS u`.execute(t);
      expect(r.rows[0]!.u).toBe('zveltio_rls');
    });
  }, 60_000);

  it('does not report "enforced" where SET ROLE would fail', async () => {
    const h = connectAs(NO_SET);
    expect(await initRlsEnforcementRole(h)).not.toBe('enforced');
  }, 60_000);

  it('grants itself SET on the worker and flow-reader roles at boot', async () => {
    await initRlsEnforcementRole(connectAs(ADMIN_ONLY));
    for (const role of NARROW) {
      const r = await sql<{ ok: boolean }>`
        SELECT pg_has_role(${ADMIN_ONLY}, ${role}, 'SET') AS ok`.execute(db);
      expect(r.rows[0]!.ok, role).toBe(true);
    }
  }, 60_000);

  it('the worker SQL bridge never picks a role it cannot SET', async () => {
    // NO_SET holds zveltio_worker with SET FALSE; give it a usable zveltio_rls.
    await sql.raw(`GRANT zveltio_rls TO ${NO_SET} WITH SET TRUE`).execute(db);
    const url = new URL(String(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL));
    url.username = NO_SET;
    url.password = 'p';
    const pool = new Bun.SQL(url.toString());
    const reserved = await pool.reserve();
    try {
      await reserved.unsafe('BEGIN');
      const role = await pickWorkerSqlRole(reserved);
      await reserved.unsafe(`SET LOCAL ROLE ${role}`); // what the bridge does next
      expect(role).toBe('zveltio_rls');
      await reserved.unsafe('ROLLBACK');
    } finally {
      reserved.release();
      await pool.close({ timeout: 1 });
    }
  }, 60_000);
});
