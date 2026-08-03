/**
 * Does Postgres actually apply the isolation policies to us?
 *
 * Every other tenant test in this repository asks whether the POLICY is
 * correct. None asked whether it binds — and on a stock deployment it does not.
 * `docker-compose.yml` passes `POSTGRES_USER` to the official Postgres image,
 * which creates that user as a SUPERUSER, and FORCE ROW LEVEL SECURITY does not
 * bind superusers. ENABLE, FORCE and a correct policy, and the connection reads
 * every tenant's rows regardless.
 *
 * That is why `withTenantIsolation` now issues `SET LOCAL ROLE zveltio_rls`
 * (migration 030) before setting the tenant GUC: a plain role, so the database
 * enforces isolation whatever the operator's connection happens to be.
 *
 * The first case below is the one that matters. It demonstrates the bypass
 * directly — same table, same policy, same tenant GUC, with and without the
 * role — so it fails if anyone removes the SET, and it documents why the line
 * is there. The suite as a whole would keep passing without it, because every
 * other test asserts through the application, which filters by tenant in SQL
 * as well.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const TABLE = 'zv_rls_role_probe';
const TENANT_A = '11111111-1111-1111-1111-1111111111a1';
const TENANT_B = '22222222-2222-2222-2222-2222222222b2';

d('RLS enforcement role', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await sql
      .raw(`CREATE TABLE ${TABLE} (id serial primary key, tenant_id uuid, label text)`)
      .execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`).execute(db);
    await sql
      .raw(
        `CREATE POLICY tenant_isolation_${TABLE} ON ${TABLE} ` +
          `USING (zveltio_tenant_scope_ok(tenant_id)) ` +
          `WITH CHECK (zveltio_tenant_scope_ok(tenant_id))`,
      )
      .execute(db);
    await sql
      .raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO zveltio_rls`)
      .execute(db)
      .catch(() => undefined);
    await sql
      .raw(`GRANT USAGE, SELECT ON SEQUENCE ${TABLE}_id_seq TO zveltio_rls`)
      .execute(db)
      .catch(() => undefined);
    await sql
      .raw(
        `INSERT INTO ${TABLE} (tenant_id, label) VALUES ` +
          `('${TENANT_A}', 'a-secret'), ('${TENANT_B}', 'b-secret')`,
      )
      .execute(db);
  });

  afterAll(async () => {
    await sql
      .raw(`DROP TABLE IF EXISTS ${TABLE}`)
      .execute(db)
      .catch(() => undefined);
  });

  /** A tenant transaction WITHOUT the role — what the engine used to do. */
  async function readAsConnectingUser(tenantId: string): Promise<string[]> {
    return db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);
      const r = await sql<{ label: string }>`SELECT label FROM ${sql.id(TABLE)}`.execute(trx);
      return r.rows.map((x) => x.label);
    });
  }

  /** A tenant transaction WITH the role — what it does now. */
  async function readAsRlsRole(tenantId: string): Promise<string[]> {
    return db.transaction().execute(async (trx) => {
      await sql.raw('SET LOCAL ROLE zveltio_rls').execute(trx);
      await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);
      const r = await sql<{ label: string }>`SELECT label FROM ${sql.id(TABLE)}`.execute(trx);
      return r.rows.map((x) => x.label);
    });
  }

  it('confines a tenant transaction to its own rows', async () => {
    expect(await readAsRlsRole(TENANT_A)).toEqual(['a-secret']);
    expect(await readAsRlsRole(TENANT_B)).toEqual(['b-secret']);
  });

  it('refuses a write aimed at another tenant', async () => {
    // USING without WITH CHECK would pass the read test above and still let a
    // request insert into someone else's tenant.
    await expect(
      db.transaction().execute(async (trx) => {
        await sql.raw('SET LOCAL ROLE zveltio_rls').execute(trx);
        await sql`SELECT set_config('zveltio.current_tenant', ${TENANT_A}, true)`.execute(trx);
        await sql`
          INSERT INTO ${sql.id(TABLE)} (tenant_id, label) VALUES (${TENANT_B}::uuid, 'stolen')
        `.execute(trx);
      }),
    ).rejects.toThrow();
  });

  it('is the ROLE doing the work, not the policy alone', async () => {
    // The point of the whole change. If the connecting user can bypass RLS —
    // which it can on every stock install — the identical transaction without
    // the role sees both tenants. Where the engine already runs as a plain
    // role there is nothing to demonstrate and both paths agree.
    const canBypass = await sql<{ b: boolean }>`
      SELECT (rolsuper OR rolbypassrls) AS b FROM pg_roles WHERE rolname = current_user
    `.execute(db);
    const withoutRole = await readAsConnectingUser(TENANT_A);

    if (canBypass.rows[0]?.b) {
      expect(withoutRole.sort()).toEqual(['a-secret', 'b-secret']);
    } else {
      expect(withoutRole).toEqual(['a-secret']);
    }
    expect(await readAsRlsRole(TENANT_A)).toEqual(['a-secret']);
  });

  it('the role cannot itself bypass RLS', async () => {
    // A role with SUPERUSER or BYPASSRLS would make the SET pointless, and the
    // three tests above would still pass on the day someone granted it.
    const r = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'zveltio_rls'
    `.execute(db);
    expect(r.rows[0]).toBeDefined();
    expect(r.rows[0]?.rolsuper).toBe(false);
    expect(r.rows[0]?.rolbypassrls).toBe(false);
  });
});
