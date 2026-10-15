/**
 * The request roles may read the engine's rule tables, never write them.
 *
 * `zveltio_rls` is the role every tenant transaction runs as, and the role an
 * inline extension's `ctx.db` and the worker SQL bridge fall back to where their
 * own roles are unusable — behind the SQL analyzer and nothing else. Its boot
 * grant gave it INSERT, UPDATE and DELETE on every table but the credential
 * ones, so one analyzer miss on that path could write a `god` grant into the
 * Casbin table, lift a column guard or a row rule (the triggers and policies are
 * rebuilt from those rows), or approve an extension's own credential forwarding
 * (L8). Measured on master: every statement below was ALLOWED.
 *
 * The engine writes these tables as their owner: on the pool (the row-rule and
 * column-permission admin routes now run outside the request transaction,
 * `TXN_SKIP_PREFIXES`) or through the Casbin triggers, SECURITY DEFINER since
 * migration 080. `rls-admin`, `admin-config` and the member-role tests drive
 * those writers end to end.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
// Spelled out here, not imported: dropping a table from the engine's list fails.
const CONTROL_TABLES = [
  'zvd_permissions',
  'zvd_column_permissions',
  'zvd_rls_policies',
  'zv_extension_forward_approvals',
  'zv_extension_registry',
];
const REQUEST_ROLES = ['zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader', 'zveltio_ext'];

d('control tables are read-only to the request roles', () => {
  let db: Database;
  beforeAll(async () => {
    ({ db } = await getTestApp());
    // The narrow roles lose the engine's zvd_* tables in the boot reconcile.
    const { reconcileTenantRLS } = await import('../../lib/tenancy/index.js');
    await reconcileTenantRLS(db);
  }, 120_000);

  it('no request role holds INSERT, UPDATE or DELETE on one', async () => {
    const r = await sql<{ w: string }>`
      SELECT r.rolname || ' ' || t || ' ' || p AS w
        FROM pg_roles r, unnest(${CONTROL_TABLES}::text[]) t,
             unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) p
       WHERE r.rolname = ANY(${REQUEST_ROLES}::text[])
         AND to_regclass('public.' || t) IS NOT NULL
         AND has_table_privilege(r.oid, ('public.' || t)::regclass, p)
       ORDER BY 1
    `.execute(db);
    expect(r.rows.map((x) => x.w)).toEqual([]);
  });

  it('zveltio_rls still reads them', async () => {
    const r = await sql<{ t: string }>`
      SELECT t FROM unnest(${CONTROL_TABLES}::text[]) t
       WHERE to_regclass('public.' || t) IS NOT NULL
         AND NOT has_table_privilege('zveltio_rls', ('public.' || t)::regclass, 'SELECT')
    `.execute(db);
    expect(r.rows).toEqual([]);
  });

  it('a tenant transaction cannot grant itself god or approve forwarding', async () => {
    const { withTenantIsolation, DEFAULT_TENANT_ID } = await import('../../lib/tenancy/index.js');
    // One statement per transaction: a refusal aborts it.
    const attempt = async (q: ReturnType<typeof sql>): Promise<string> => {
      try {
        await withTenantIsolation(DEFAULT_TENANT_ID, (trx) => q.execute(trx));
        return 'ALLOWED';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const results = await Promise.all([
      attempt(
        sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES ('g', 'ctl-probe', 'god', '*')`,
      ),
      attempt(sql`DELETE FROM zvd_column_permissions WHERE role = 'ctl-probe'`),
      attempt(sql`DELETE FROM zvd_rls_policies WHERE role = 'ctl-probe'`),
      attempt(
        sql`INSERT INTO zv_extension_forward_approvals (name, approved) VALUES ('ctl-probe', '{}')`,
      ),
      attempt(sql`UPDATE zv_extension_registry SET granted_capabilities = NULL WHERE false`),
    ]);
    await sql`DELETE FROM zvd_permissions WHERE v0 = 'ctl-probe'`.execute(db);
    await sql`DELETE FROM zv_extension_forward_approvals WHERE name = 'ctl-probe'`.execute(db);
    for (const r of results) expect(r).toMatch(/permission denied/i);
  });
});
