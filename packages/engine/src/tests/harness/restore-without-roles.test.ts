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
 * Such a restore drops every privilege naming the role, the marker's EXECUTE
 * among them; boot reads only that grant, so revoking it is the restore as boot
 * sees it. (`DROP OWNED BY` would need membership in the role, which a
 * non-superuser owner does not hold.) Rolled back, so the shared harness
 * database is untouched.
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
    expect(r.rows[0]?.note).toBe('zveltio_audit_purge,zveltio_rls');
  });

  it('refuses a database whose grants to a recorded role did not survive', async () => {
    const { db } = await getTestApp();
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`REVOKE EXECUTE ON FUNCTION ${sql.raw(MARKER)} FROM zveltio_audit_purge`.execute(
          trx,
        );
        await enforceRoleGrantsMarker(trx);
        // Never committed: a regression that stops refusing must not drop the
        // role's grants from the shared harness database for every later file.
        throw new Rollback();
      }),
    ).rejects.toThrow(/restored without the engine's database roles: zveltio_audit_purge held/);
  });

  it('starts, and records it, when a role appears that the engine never saw', async () => {
    const { db } = await getTestApp();
    await expect(
      db.transaction().execute(async (trx) => {
        // An install that gains zveltio_audit_purge after 121 ran (CREATEROLE granted later).
        await sql`REVOKE EXECUTE ON FUNCTION ${sql.raw(MARKER)} FROM zveltio_audit_purge`.execute(
          trx,
        );
        await sql`COMMENT ON FUNCTION ${sql.raw(MARKER)} IS 'zveltio_rls'`.execute(trx);
        await enforceRoleGrantsMarker(trx);
        const r = await sql<{ ok: boolean; note: string }>`
          SELECT has_function_privilege('zveltio_audit_purge', ${MARKER}, 'EXECUTE') AS ok,
                 obj_description(${MARKER}::regprocedure, 'pg_proc') AS note`.execute(trx);
        expect(r.rows[0]).toEqual({
          ok: true,
          note: 'zveltio_audit_purge,zveltio_rls',
        });
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});
