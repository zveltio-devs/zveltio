/**
 * `zveltio_worker` and `zveltio_flow_reader` are retired (migration 136, RFC
 * extension-model-v3 phase D slice 4 step 3): no SQL crosses from a worker
 * (#1911) and flow `query_db` is gone (ADR 0058), yet each role still held DML
 * or SELECT on every collection, granted at create time and at every boot.
 *
 * - A collection created by the real road grants neither role anything.
 * - Boot neither recreates nor re-grants them, and the grants marker stops
 *   naming them (otherwise a revoke would read as a restore without roles).
 * - The migration takes back what an older engine granted here, and drops this
 *   database's per-extension worker roles. A shared role is dropped only once no
 *   other database on the cluster depends on it.
 *
 * Roles belong to the cluster, and other databases (other test databases on a
 * developer's cluster) may hold grants to them: every assertion holds whether
 * the shared roles exist when it runs or not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  enforceRoleGrantsMarker,
  ensureRlsEnforcementRole,
  reconcileTenantRLS,
} from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const RETIRED = ['zveltio_worker', 'zveltio_flow_reader'];
const COLL = `retired_${Date.now().toString(36)}`;
const TABLE = `zvd_${COLL}`;
const EXT = `retprobe/${Date.now().toString(36)}`;
const MIGRATION = join(
  import.meta.dir,
  '../../db/migrations/sql/136_retire_worker_and_flow_reader_roles.sql',
);
const MARKER = 'public.zveltio_role_grants_marker()';

/** What `extensionDbRoleNames` named a worker extension's role before 136. */
function workerRoleName(dbName: string, extName: string): string {
  const stem = extName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 38);
  const h = createHash('sha256').update(`${dbName}\0${extName}`).digest('hex').slice(0, 10);
  return `zveltio_wrk_${stem}_${h}`;
}

d('the worker and flow-reader roles are retired', () => {
  let db: Database;
  let dbName = '';

  /** Every privilege `role` holds in this database: relations, routines, the schema. */
  const heldHere = async (role: string): Promise<number> =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_catalog.pg_shdepend d
          JOIN pg_catalog.pg_roles r ON r.oid = d.refobjid AND r.rolname = ${role}
         WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass
           AND d.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())`.execute(
        db,
      )
    ).rows[0]!.n;
  const exists = async (role: string) =>
    (
      await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`.execute(db)
    ).rows[0]!.n === 1;
  /** Kept only while another database of the cluster still depends on it. */
  const heldElsewhere = async (role: string) =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_catalog.pg_shdepend d
          JOIN pg_catalog.pg_roles r ON r.oid = d.refobjid AND r.rolname = ${role}
         WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass
           AND d.dbid <> (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())`.execute(
        db,
      )
    ).rows[0]!.n > 0;
  const markerNote = async () =>
    (
      await sql<{ note: string | null }>`
        SELECT obj_description(${MARKER}::regprocedure, 'pg_proc') AS note`.execute(db)
    ).rows[0]!.note ?? '';
  const run = async (half: 'up' | 'down') => {
    const parsed = parseMigrationFile(await Bun.file(MIGRATION).text());
    for (const stmt of splitSqlStatements(parsed[half] ?? '')) await sql.raw(stmt).execute(db);
  };

  beforeAll(async () => {
    let app: Hono;
    ({ app, db } = await getTestApp());
    dbName = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d;
    const cookie = await createGodSession(app, db);
    const made = await app.request('/api/collections', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: COLL,
        display_name: COLL,
        fields: [{ name: 'title', type: 'text' }],
      }),
    });
    expect([200, 201, 202]).toContain(made.status);
    // The DDL job grants the collection's roles last (applyTenantRLS).
    for (let i = 0; i < 150; i++) {
      const seen = await sql<{ ok: boolean }>`
        SELECT to_regclass(${TABLE}) IS NOT NULL
               AND has_table_privilege('zveltio_ext', ${TABLE}, 'DELETE') AS ok`.execute(db);
      if (seen.rows[0]!.ok) break;
      await Bun.sleep(100);
    }
  }, 60_000);

  afterAll(async () => {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    // A run whose migration left the role (the case this file guards) must not leak it.
    const own = workerRoleName(dbName, EXT);
    // As the migration takes them back: DROP OWNED BY needs the role's
    // privileges, which a non-superuser owner that created it does not hold.
    await sql
      .raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${own}') THEN
              REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${own};
              REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM ${own};
              REVOKE ALL ON SCHEMA public FROM ${own};
              DROP ROLE ${own}; END IF; END $$`)
      .execute(db);
    await DDLManager.dropCollection(db, COLL).catch(() => undefined);
  });

  it('a collection created by the real road grants neither role anything', async () => {
    const r = await sql<{ grantee: string }>`
      SELECT grantee FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = ${TABLE}
         AND grantee = ANY(${RETIRED}::text[])`.execute(db);
    expect(r.rows).toEqual([]);
  });

  it('boot neither re-grants them nor names them on the grants marker', async () => {
    await ensureRlsEnforcementRole(db);
    await reconcileTenantRLS(db);
    await enforceRoleGrantsMarker(db);
    for (const role of RETIRED)
      expect({ role, held: await heldHere(role) }).toEqual({ role, held: 0 });
    for (const role of RETIRED) expect((await markerNote()).split(',')).not.toContain(role);
  }, 60_000);

  it('takes back what an older engine granted, and drops this database’s worker roles', async () => {
    const own = workerRoleName(dbName, EXT);
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${EXT}, ${EXT}, true, true)`.execute(db);
    // What an engine before 136 left: the shared roles on the collection, the
    // schema and the marker, and a worker extension's own role.
    await run('down');
    for (const role of [...RETIRED, own]) {
      await sql
        .raw(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}')
                     THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`)
        .execute(db);
      await sql.raw(`GRANT SELECT ON ${TABLE} TO ${role}`).execute(db);
      await sql.raw(`GRANT EXECUTE ON FUNCTION ${MARKER} TO ${role}`).execute(db);
    }
    // An older engine made each worker role a member of zveltio_worker. Granting
    // that needs ADMIN on zveltio_worker, which a non-superuser owner has only
    // when it created the role (`run('down')` above, on a cluster without it).
    // One another database left — made by a superuser, as the beta chain's 001
    // does in baseline-equivalence.test.ts — is not this owner's to grant, and
    // the migration finds and drops the worker role by name, not by membership:
    // the membership is left out then, and every assertion below still holds.
    const mayGrant = (
      await sql<{ ok: boolean }>`
        SELECT pg_has_role(current_user, 'zveltio_worker', 'MEMBER WITH ADMIN OPTION') AS ok`.execute(
        db,
      )
    ).rows[0]!.ok;
    if (mayGrant) await sql.raw(`GRANT zveltio_worker TO ${own}`).execute(db);
    await sql
      .raw(
        `COMMENT ON FUNCTION ${MARKER} IS '${['zveltio_audit_purge', 'zveltio_flow_reader', 'zveltio_rls', 'zveltio_worker'].join(',')}'`,
      )
      .execute(db);

    await run('up');
    for (const role of [...RETIRED, own]) {
      expect({ role, held: await heldHere(role) }).toEqual({ role, held: 0 });
    }
    expect(await exists(own)).toBe(false);
    for (const role of RETIRED) {
      expect({ role, kept: await exists(role) }).toEqual({ role, kept: await heldElsewhere(role) });
    }
    expect(await markerNote()).toBe('zveltio_audit_purge,zveltio_rls');
    // And the engine boots on it: the marker does not read the revoke as a restore.
    await enforceRoleGrantsMarker(db);
  }, 60_000);
});
