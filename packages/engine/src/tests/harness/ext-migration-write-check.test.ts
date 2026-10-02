/**
 * An extension installed at runtime may not let a parent unit write into a child.
 *
 * Every first-party `tenant_isolation_*` policy is written with the READ
 * predicate in WITH CHECK — `zveltio_tenant_scope_ok(tenant_id)`, which is the
 * whole subtree for a consolidating parent. `reconcileExtensionTenantRLS`
 * rewrites that to `zveltio_tenant_write_ok` (own node only), but it ran at
 * boot alone, so an extension enabled from the marketplace kept the read
 * predicate on its writes until the next restart: a parent with
 * `read_scope = 'subtree'` could INSERT rows into its child's tenant.
 *
 * Driven through `runExtensionMigrations`, the function every load path —
 * boot, marketplace install, enable — runs an extension's DDL through.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { runExtensionMigrations } from '../../lib/extensions/migration-runner.js';
import { withTenantIsolation } from '../../lib/tenancy/tenant-manager.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const PARENT = '3b000000-0000-0000-0000-000000000090';
const CHILD = '3b000000-0000-0000-0000-0000000000a1';
const USER = 'extwc-probe-user-parent';
const EXT = 'extwcprobe';
const TABLE = `zv_${EXT}_rows`;
const DIR = `${process.env.TMPDIR ?? '/tmp'}/zv-extwc-${Date.now()}`;

// The first-party template, verbatim in shape (e.g. graphql/002_tenant_rls.sql).
const MIGRATION = `
CREATE TABLE ${TABLE} (id serial PRIMARY KEY, tenant_id uuid NOT NULL, label text);
ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_${TABLE} ON ${TABLE}
  USING (zveltio_tenant_scope_ok(tenant_id))
  WITH CHECK (zveltio_tenant_scope_ok(tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO zveltio_rls;
GRANT USAGE, SELECT ON SEQUENCE ${TABLE}_id_seq TO zveltio_rls;
`;

d('extension migrations: WITH CHECK is the own node, from the first write', () => {
  let db: Database;

  async function cleanup(): Promise<void> {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${EXT}:%`}`.execute(db);
    await sql`DELETE FROM zv_tenant_users WHERE user_id = ${USER}`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${USER}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id IN (${CHILD}::uuid, ${PARENT}::uuid)`.execute(db);
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await cleanup();
    await sql`
      INSERT INTO zv_tenants (id, slug, name, parent_id) VALUES
        (${PARENT}::uuid, 'extwc-parent', 'Parent', NULL),
        (${CHILD}::uuid,  'extwc-child',  'Child',  ${PARENT}::uuid)
    `.execute(db);
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${USER}, ${USER}, 'extwc-parent@test.invalid', true, 'member', now(), now())
    `.execute(db);
    await sql`
      INSERT INTO zv_tenant_users (tenant_id, user_id, role, read_scope, valid_from)
      VALUES (${PARENT}::uuid, ${USER}, 'admin', 'subtree', now() - interval '1 day')
    `.execute(db);

    await Bun.write(`${DIR}/001_init.sql`, MIGRATION);
    const ext = {
      name: EXT,
      getMigrations: () => [`${DIR}/001_init.sql`],
    } as unknown as ZveltioExtension;
    await runExtensionMigrations(ext, db);
  }, 60_000);

  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
    await Bun.$`rm -rf ${DIR}`.quiet().nothrow();
  });

  const writeAsParent = (tenantId: string) =>
    withTenantIsolation(
      PARENT,
      async (trx) => {
        await sql`
          INSERT INTO ${sql.id(TABLE)} (tenant_id, label) VALUES (${tenantId}::uuid, 'from-parent')
        `.execute(trx);
      },
      { userId: USER },
    );

  it('the parent writes its own rows', async () => {
    // The control: without it a refusal below could be a missing grant.
    await writeAsParent(PARENT);
  });

  it('the parent cannot write into the child it reads', async () => {
    await expect(writeAsParent(CHILD)).rejects.toThrow(/row-level security/);
  });
});
