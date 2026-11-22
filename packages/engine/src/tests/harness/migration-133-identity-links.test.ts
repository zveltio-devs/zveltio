/**
 * Migration 133 carries `auth/scim`'s provisioning state into
 * `zv_identity_links` for EVERY tenant. 120 did the same copy with no tenant
 * set, and on the documented install (a NOSUPERUSER NOBYPASSRLS owner) the
 * collection table's RLS let it read the default tenant's rows only — or none,
 * fail-closed: every other tenant's SCIM provider lost its accounts.
 *
 * The copy runs here under a role RLS binds (`zveltio_rls`, given the grants
 * inside the transaction), so the superuser lane proves what the owner lane
 * would. Everything is planted in a transaction that is rolled back.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROLLBACK = new Error('rollback');
const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER_TENANT = crypto.randomUUID();
const TAG = `m133_${Date.now()}`;

d('133 carries every tenant SCIM link over', () => {
  it('copies the rows of a tenant other than the default one, under RLS', async () => {
    const { db } = await getTestApp();
    const { up } = parseMigrationFile(
      await Bun.file(
        new URL('../../db/migrations/sql/133_identity_links_every_tenant.sql', import.meta.url),
      ).text(),
    );
    let links: { tenant_id: string; user_id: string }[] = [];
    const run = db.transaction().execute(async (trx) => {
      await sql`INSERT INTO zv_tenants (id, slug, name) VALUES (${OTHER_TENANT}, ${TAG}, ${TAG})`.execute(
        trx,
      );
      for (const u of [`${TAG}_default`, `${TAG}_other`]) {
        await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
                  VALUES (${u}, ${u}, ${`${u}@example.test`}, true, now(), now())`.execute(trx);
      }
      // Shaped like a collection table (tenant-manager.ts, tenant_isolation).
      await sql`CREATE TABLE zvd_scim_users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
        user_id text, active boolean DEFAULT true,
        suspended_at timestamptz, held_valid_to timestamptz)`.execute(trx);
      await sql`INSERT INTO zvd_scim_users (tenant_id, user_id) VALUES
        (${DEFAULT_TENANT}, ${`${TAG}_default`}), (${OTHER_TENANT}, ${`${TAG}_other`})`.execute(trx);
      await sql`ALTER TABLE zvd_scim_users ENABLE ROW LEVEL SECURITY`.execute(trx);
      await sql`ALTER TABLE zvd_scim_users FORCE ROW LEVEL SECURITY`.execute(trx);
      await sql`CREATE POLICY tenant_isolation ON zvd_scim_users
        USING (tenant_id = ANY (zveltio_visible_tenants()))
        WITH CHECK (zveltio_tenant_write_ok(tenant_id))`.execute(trx);
      await sql`GRANT SELECT ON zvd_scim_users, "user", zv_tenants TO zveltio_rls`.execute(trx);
      await sql`GRANT SELECT, INSERT ON zv_identity_links TO zveltio_rls`.execute(trx);

      await sql`SET LOCAL ROLE zveltio_rls`.execute(trx);
      await sql.raw(up).execute(trx);
      await sql`RESET ROLE`.execute(trx);

      // The owner lane is bound by the links' own policy too.
      await sql`SELECT set_config('zveltio.visible_tenants', ${`${DEFAULT_TENANT},${OTHER_TENANT}`}, true)`.execute(
        trx,
      );
      links = (
        await sql<{ tenant_id: string; user_id: string }>`
          SELECT tenant_id::text AS tenant_id, user_id FROM zv_identity_links
           WHERE user_id LIKE ${`${TAG}%`} ORDER BY user_id`.execute(trx)
      ).rows;
      throw ROLLBACK;
    });
    await expect(run).rejects.toBe(ROLLBACK);
    expect(links).toEqual([
      { tenant_id: DEFAULT_TENANT, user_id: `${TAG}_default` },
      { tenant_id: OTHER_TENANT, user_id: `${TAG}_other` },
    ]);
  }, 60_000);
});
