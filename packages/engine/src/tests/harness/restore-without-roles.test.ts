/**
 * A database restored onto a server without the engine's roles refuses to boot.
 *
 * The roles are cluster objects: `pg_dump` does not carry them, and every GRANT
 * in the dump naming one fails on a new server. Boot recreated `zveltio_rls` and
 * re-granted its tables, but not what migrations granted one object at a time
 * (`zvv__revisions`, `zveltio_media_used_bytes`, default privileges, the narrow
 * roles' schema USAGE), and logged "Tenant RLS enforced". Measured 2026-11-13:
 * a fresh install dumped and restored onto a second, role-less cluster came up
 * with `permission denied for view zvv__revisions` as zveltio_rls.
 *
 * `DROP OWNED BY` leaves this database exactly as such a restore does for that
 * role: every privilege naming it gone, the role itself still there (boot
 * recreates it). Rolled back, so the shared harness database is untouched.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { enforceRoleGrantsMarker } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const MARKER = 'public.zveltio_role_grants_marker()';
class Rollback extends Error {}

d('a restore without the engine roles', () => {
  // What boot does. Again here: the app is booted once per process, and a migration
  // down/up elsewhere in the run rebuilds the marker without its record.
  beforeAll(async () => {
    const { db } = await getTestApp();
    await enforceRoleGrantsMarker(db);
  });

  it('boot recorded every engine role on the marker', async () => {
    const { db } = await getTestApp();
    const r = await sql<{ note: string }>`
      SELECT obj_description(${MARKER}::regprocedure, 'pg_proc') AS note`.execute(db);
    expect(r.rows[0]?.note).toBe('zveltio_flow_reader,zveltio_rls,zveltio_worker');
  });

  it('refuses a database whose grants to a recorded role did not survive', async () => {
    const { db } = await getTestApp();
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`DROP OWNED BY zveltio_flow_reader`.execute(trx);
        await enforceRoleGrantsMarker(trx);
      }),
    ).rejects.toThrow(/restored without the engine's database roles: zveltio_flow_reader held/);
  });

  it('starts, and records it, when a role appears that the engine never saw', async () => {
    const { db } = await getTestApp();
    await expect(
      db.transaction().execute(async (trx) => {
        // An install that gains zveltio_worker after 121 ran (CREATEROLE granted later).
        await sql`REVOKE EXECUTE ON FUNCTION ${sql.raw(MARKER)} FROM zveltio_worker`.execute(trx);
        await sql`COMMENT ON FUNCTION ${sql.raw(MARKER)} IS 'zveltio_flow_reader,zveltio_rls'`.execute(
          trx,
        );
        await enforceRoleGrantsMarker(trx);
        const r = await sql<{ ok: boolean; note: string }>`
          SELECT has_function_privilege('zveltio_worker', ${MARKER}, 'EXECUTE') AS ok,
                 obj_description(${MARKER}::regprocedure, 'pg_proc') AS note`.execute(trx);
        expect(r.rows[0]).toEqual({
          ok: true,
          note: 'zveltio_flow_reader,zveltio_rls,zveltio_worker',
        });
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});
