/**
 * No restricted role may create temporary objects, and none reaches a ghost
 * migration's changelog.
 *
 * TEMPORARY came to every role through PUBLIC, so a statement an analyzer let
 * through could leave a temp table on a pooled connection, ahead of the engine's
 * own tables in the next borrower's search path (lib/tenancy/temp-privilege.ts).
 * The changelog holds every tenant's rows without RLS and was granted to
 * `zveltio_rls` by default privileges at CREATE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import {
  applyTenantRLS,
  restrictTemporaryObjects,
  temporaryObjectsRestricted,
} from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROLES = ['zveltio_rls', 'zveltio_ext', 'zveltio_worker', 'zveltio_flow_reader'];
const COLLECTION = `notemp_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;

d('restricted roles: no temporary objects, no changelog', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
  }, 60_000);

  afterAll(async () => {
    for (const t of [`_zv_ghost_${TABLE}`, `_zv_changelog_${TABLE}`, TABLE]) {
      await sql`DROP TABLE IF EXISTS ${sql.table(t)} CASCADE`.execute(db);
    }
    await sql`DROP FUNCTION IF EXISTS ${sql.id(`_zv_trg_ghost_${TABLE}_fn`)}()`.execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
  });

  const createTempAs = async (role: string | null): Promise<string> => {
    try {
      await db.transaction().execute(async (trx) => {
        if (role) await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx);
        await sql`CREATE TEMP TABLE zz_notemp_probe (id int) ON COMMIT DROP`.execute(trx);
      });
      return 'created';
    } catch (err) {
      return (err as Error).message;
    }
  };

  const onDatabase = (stmt: string) =>
    sql`DO $$ BEGIN EXECUTE format(${sql.lit(stmt)}, current_database()); END $$`.execute(db);

  it('refuses CREATE TEMP to every restricted role after boot', async () => {
    // Start from what Postgres gives every database — TEMPORARY on PUBLIC — so
    // the outcome is this boot's, not one left in a reused database.
    await onDatabase('GRANT TEMPORARY ON DATABASE %I TO PUBLIC');
    try {
      for (const role of ROLES) expect(await createTempAs(role), role).toBe('created');
      expect(await restrictTemporaryObjects(db)).toBe(true);
      const out: Record<string, string> = {};
      for (const role of ROLES) out[role] = await createTempAs(role);
      for (const role of ROLES) expect(out[role], role).toMatch(/permission denied/);
      expect(temporaryObjectsRestricted()).toBe(true);
    } finally {
      await restrictTemporaryObjects(db);
    }
  }, 60_000);

  it('reads back a restricted role that holds TEMPORARY in its own name', async () => {
    // REVOKE FROM PUBLIC leaves a direct grant in place; the worker bridge then
    // has to discard temp objects itself, so the check must say so.
    const perExt = 'zveltio_ext_notempprobe_0123456789'; // ext-db-role.ts' name shape
    await sql`CREATE ROLE ${sql.id(perExt)} NOLOGIN`.execute(db);
    try {
      for (const role of [perExt, 'zveltio_worker']) {
        await onDatabase(`GRANT TEMPORARY ON DATABASE %I TO ${role}`);
        expect(await restrictTemporaryObjects(db), role).toBe(false);
        expect(temporaryObjectsRestricted(), role).toBe(false);
        await onDatabase(`REVOKE TEMPORARY ON DATABASE %I FROM ${role}`);
      }
    } finally {
      await onDatabase(`REVOKE TEMPORARY ON DATABASE %I FROM zveltio_worker`);
      await onDatabase(`REVOKE ALL ON DATABASE %I FROM ${perExt}`).catch(() => {});
      await sql`DROP ROLE IF EXISTS ${sql.id(perExt)}`.execute(db);
    }
    expect(await restrictTemporaryObjects(db)).toBe(true);
  }, 60_000);

  it('leaves the engine role its own temp tables (migration 001 needs them)', async () => {
    expect(await createTempAs(null)).toBe('created');
  }, 30_000);

  it('is idempotent at the next boot', async () => {
    expect(await restrictTemporaryObjects(db)).toBe(true);
    expect(await restrictTemporaryObjects(db)).toBe(true);
    expect(await createTempAs(null)).toBe('created');
  }, 30_000);

  it('grants nobody but the owner the changelog or its sequence', async () => {
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await applyTenantRLS(db, TABLE);
    const changelog = `_zv_changelog_${TABLE}`;
    await GhostDDL.createGhost(db, TABLE, [
      { kind: 'add_column', field: { name: 'extra', type: 'text', required: false } },
    ] as never);
    const r = await sql<{ rel: string; grantee: string; privilege: string }>`
      SELECT c.relname AS rel,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
             a.privilege_type AS privilege
        FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       WHERE c.oid IN (to_regclass(quote_ident(${changelog})),
                       pg_get_serial_sequence(quote_ident(${changelog}), 'id')::regclass)
         AND a.grantee <> c.relowner
    `.execute(db);
    expect(r.rows).toEqual([]);
    const reach = await sql<{ role: string; ok: boolean }>`
      SELECT role, has_table_privilege(role, ${changelog}, 'SELECT, INSERT, UPDATE, DELETE') AS ok
        FROM unnest(${ROLES}::text[]) role
    `.execute(db);
    expect(reach.rows.filter((x) => x.ok)).toEqual([]);
  }, 60_000);
});
