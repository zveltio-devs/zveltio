/**
 * The engine roles a built-in backup carries (ADR 0047 decision 2).
 *
 * Measured 2026-11-13 before it did: a `POST /api/backup` archive restored onto
 * a cluster without the engine's roles stopped at `role "zveltio_flow_reader"
 * does not exist` under `ON_ERROR_STOP=1`, and without it the engine refused to
 * boot (migration 121's marker). `scripts/dr-drill.sh` section 1b restores the
 * built-in backup onto such a cluster end to end; this pins which roles the
 * archive names and that its SQL creates a missing one and leaves a present one
 * alone. Every role made here is made inside a transaction that rolls back.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { engineRolesSql } from '../../lib/backup/dump.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
class Rollback extends Error {}

/** Run `fn` in a transaction that never commits. */
async function rolledBack(db: Database, fn: (trx: Database) => Promise<void>): Promise<void> {
  await expect(
    db.transaction().execute(async (trx) => {
      await fn(trx as unknown as Database);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

d('the engine roles in a built-in backup', () => {
  let db: Database;
  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  it("names the roles this database's grants depend on, and no other zveltio_ role", async () => {
    await rolledBack(db, async (trx) => {
      // An extension role with a grant here, and one that only another database
      // on the cluster would use.
      await sql`CREATE ROLE zveltio_wrk_probe_here NOLOGIN`.execute(trx);
      await sql`GRANT SELECT ON zv_settings TO zveltio_wrk_probe_here`.execute(trx);
      await sql`CREATE ROLE zveltio_wrk_probe_elsewhere NOLOGIN`.execute(trx);
      // A login role is the operator's: it has a password the backup must not hold.
      await sql`CREATE ROLE zveltio_probe_login LOGIN`.execute(trx);
      await sql`GRANT SELECT ON zv_settings TO zveltio_probe_login`.execute(trx);

      const text = await engineRolesSql(trx);
      for (const role of ['zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader']) {
        expect(text).toContain(`CREATE ROLE ${role} NOLOGIN`);
      }
      expect(text).toContain('CREATE ROLE zveltio_wrk_probe_here NOLOGIN');
      expect(text).not.toContain('zveltio_wrk_probe_elsewhere');
      expect(text).not.toContain('zveltio_probe_login');
      expect(text).not.toMatch(/PASSWORD|GRANT/);
    });
  });

  it('creates a missing role and leaves a present one alone', async () => {
    await rolledBack(db, async (trx) => {
      // NOBYPASSRLS: only a role that has BYPASSRLS may grant it, and the CI lane
      // runs the engine as a non-superuser owner.
      await sql`CREATE ROLE zveltio_wrk_probe_gone NOLOGIN`.execute(trx);
      await sql`GRANT SELECT ON zv_settings TO zveltio_wrk_probe_gone`.execute(trx);
      const text = await engineRolesSql(trx);
      // REVOKE, not DROP OWNED: a non-superuser owner lacks the privileges of the role.
      await sql`REVOKE SELECT ON zv_settings FROM zveltio_wrk_probe_gone`.execute(trx);
      await sql`DROP ROLE zveltio_wrk_probe_gone`.execute(trx);

      // Twice: the second run finds every role present, which is a restore onto
      // the cluster the backup came from, and must not error.
      await sql.raw(text).execute(trx);
      await sql.raw(text).execute(trx);
      const r = await sql<{ rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean }>`
        SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles
         WHERE rolname = 'zveltio_wrk_probe_gone'`.execute(trx);
      expect(r.rows).toEqual([{ rolcanlogin: false, rolbypassrls: false, rolsuper: false }]);
    });
  });
});
