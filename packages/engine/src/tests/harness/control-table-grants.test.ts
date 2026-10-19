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
 * those writers end to end; `settings`, `storage-admin`, `recovery-bootstrap`,
 * `tenant-rate-limit` and `permissions` drive the `zv_roles`/`zv_settings` ones.
 *
 * Those triggers' functions run as the owner, so attaching one to a table of
 * one's own is a write as the owner: EXECUTE on them is the owner's (082, and
 * 083 for the sync tombstone trigger).
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { asTenant, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
// Spelled out here, not imported: dropping a table from the engine's list fails.
const CONTROL_TABLES = [
  'zvd_permissions',
  'zvd_column_permissions',
  'zvd_rls_policies',
  'zv_extension_forward_approvals',
  'zv_extension_registry',
  // An operator's revoke of a default grant (086): deleting one hands the grant
  // back to every tenant at the next boot.
  'zv_default_grant_revocations',
  // Roles and instance settings (registration, SMTP, storage, recovery tokens).
  'zv_roles',
  'zv_settings',
  // God status is "user".role, and email and banned decide who signs in.
  'user',
];
const REQUEST_ROLES = ['zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader', 'zveltio_ext'];

// Where boot cannot take TEMPORARY from PUBLIC (temp-privilege.ts) the request
// role owns temp tables; that is the state the trigger tests reproduce.
const temp = (verb: 'GRANT' | 'REVOKE') => sql`
  DO $t$ BEGIN
    EXECUTE format('${sql.raw(verb)} TEMPORARY ON DATABASE %I ${sql.raw(verb === 'GRANT' ? 'TO' : 'FROM')} zveltio_rls', current_database());
  END $t$`;

d('control tables are read-only to the request roles', () => {
  let db: Database;
  beforeAll(async () => {
    ({ db } = await getTestApp());
    // The narrow roles lose the engine's zvd_* tables in the boot reconcile.
    const { reconcileTenantRLS } = await import('../../lib/tenancy/index.js');
    await reconcileTenantRLS(db);
  }, 120_000);

  const writeGrants = async (): Promise<string[]> => {
    const r = await sql<{ w: string }>`
      SELECT r.rolname || ' ' || t || ' ' || p AS w
        FROM pg_roles r, unnest(${CONTROL_TABLES}::text[]) t,
             unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) p
       WHERE r.rolname = ANY(${REQUEST_ROLES}::text[])
         AND to_regclass('public.' || t) IS NOT NULL
         AND has_table_privilege(r.oid, ('public.' || t)::regclass, p)
       ORDER BY 1
    `.execute(db);
    return r.rows.map((x) => x.w);
  };

  it('no request role holds INSERT, UPDATE or DELETE on one', async () => {
    expect(await writeGrants()).toEqual([]);
  });

  // Migration 001's ALTER DEFAULT PRIVILEGES hands zveltio_rls DML on every
  // table created later, control tables included (071, 086), and only boot took
  // it back. POST /admin/migrate and `zveltio migrate` beside a running engine
  // left the grant in place until the next restart; in the harness a test that
  // rolled back and re-applied a migration left it for every file after it.
  it('a migration applied on a running engine does not hand one back', async () => {
    const { rollbackMigration, runMigrations } = await import('../../db/migrations/index.js');
    expect((await rollbackMigration(db, 85)).success).toBe(true);
    await runMigrations(db);
    expect(await writeGrants()).toEqual([]);
  }, 120_000);

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
      attempt(sql`INSERT INTO zv_roles (name) VALUES ('ctl-probe')`),
      attempt(sql`INSERT INTO zv_settings (key, value) VALUES ('ctl-probe', 'true'::jsonb)`),
      attempt(sql`UPDATE "user" SET role = 'god' WHERE false`),
      attempt(sql`UPDATE "user" SET email = 'ctl-probe@probe.invalid' WHERE false`),
      attempt(sql`UPDATE "user" SET banned = false WHERE false`),
      attempt(sql`DELETE FROM "user" WHERE false`),
      attempt(
        sql`INSERT INTO "user" (id, name, email) VALUES ('ctl-probe', 'p', 'ctl-probe@probe.invalid')`,
      ),
      attempt(sql`SELECT 1 FROM "user" WHERE false FOR UPDATE`),
    ]);
    await sql`DELETE FROM "user" WHERE id = 'ctl-probe'`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v0 = 'ctl-probe'`.execute(db);
    await sql`DELETE FROM zv_extension_forward_approvals WHERE name = 'ctl-probe'`.execute(db);
    await sql`DELETE FROM zv_roles WHERE name = 'ctl-probe'`.execute(db);
    await sql`DELETE FROM zv_settings WHERE key = 'ctl-probe'`.execute(db);
    for (const r of results) expect(r).toMatch(/permission denied/i);
  });

  // Migration 080's trigger drops every Casbin row whose subject is the deleted
  // user's id, and a role's policies sit under the same v0: a "user" row named
  // after a role, inserted and deleted again, took that role's grants with it.
  it("a tenant transaction cannot drop a role's policies through a user named after it", async () => {
    const { withTenantIsolation, DEFAULT_TENANT_ID } = await import('../../lib/tenancy/index.js');
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
              VALUES ('p', 'ctl-role', '*', 'ctl-things', 'read') ON CONFLICT DO NOTHING`.execute(
      db,
    );
    let result = 'ALLOWED';
    try {
      await withTenantIsolation(DEFAULT_TENANT_ID, async (trx) => {
        await sql`INSERT INTO "user" (id, name, email)
                  VALUES ('ctl-role', 'r', 'ctl-role@probe.invalid')`.execute(trx);
        await sql`DELETE FROM "user" WHERE id = 'ctl-role'`.execute(trx);
      });
    } catch (err) {
      result = (err as Error).message;
    }
    const left = await sql`SELECT 1 FROM zvd_permissions WHERE v0 = 'ctl-role'`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v0 = 'ctl-role'`.execute(db);
    await sql`DELETE FROM "user" WHERE id = 'ctl-role'`.execute(db);
    expect(left.rows.length).toBe(1);
    expect(result).toMatch(/permission denied/i);
  });

  it('a role that owns a table cannot attach the owner-rights Casbin triggers to it', async () => {
    const { withTenantIsolation, DEFAULT_TENANT_ID } = await import('../../lib/tenancy/index.js');
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES ('g', 'ctl-victim', 'admin', '*')
              ON CONFLICT DO NOTHING`.execute(db);
    await temp('GRANT').execute(db);
    const attempt = async (fn: string): Promise<string> => {
      try {
        await withTenantIsolation(DEFAULT_TENANT_ID, async (trx) => {
          await sql`CREATE TEMP TABLE ctl_probe (id text, user_id text, tenant_id uuid) ON COMMIT DROP`.execute(
            trx,
          );
          await sql`CREATE TRIGGER ctl_probe AFTER INSERT OR DELETE ON ctl_probe
                    FOR EACH ROW EXECUTE FUNCTION ${sql.raw(`public.${fn}()`)}`.execute(trx);
          await sql`INSERT INTO ctl_probe VALUES ('ctl-victim', 'ctl-victim', ${DEFAULT_TENANT_ID})`.execute(
            trx,
          );
          await sql`DELETE FROM ctl_probe`.execute(trx);
        });
        return 'ALLOWED';
      } catch (err) {
        return (err as Error).message;
      }
    };
    let results: string[];
    try {
      results = [];
      for (const fn of [
        'zveltio_grant_member_role',
        'zveltio_drop_deleted_user_grants',
        'zveltio_drop_removed_member_grants',
      ]) {
        results.push(await attempt(fn));
      }
    } finally {
      await temp('REVOKE').execute(db);
    }
    const left = await sql<{ v1: string }>`
      SELECT v1 FROM zvd_permissions WHERE v0 = 'ctl-victim' ORDER BY v1`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v0 = 'ctl-victim'`.execute(db);
    for (const r of results) expect(r).toMatch(/permission denied for function/i);
    expect(left.rows.map((x) => x.v1)).toEqual(['admin']);
  });

  // zveltio_sync_tombstone() writes one tombstone per deleted row, in that
  // row's unit, as its owner. On a table of one's own every column is chosen:
  // any unit, any id, any collection (the table's name), and sync pull then
  // tells that unit's clients to drop the row (083).
  it('a role that owns a table cannot attach the owner-rights tombstone trigger to it', async () => {
    const { withTenantIsolation, DEFAULT_TENANT_ID } = await import('../../lib/tenancy/index.js');
    const victim = '4d000000-0000-0000-0000-0000000000e3';
    const row = crypto.randomUUID();
    await temp('GRANT').execute(db);
    let result = 'ALLOWED';
    try {
      await withTenantIsolation(DEFAULT_TENANT_ID, async (trx) => {
        await sql`CREATE TEMP TABLE zvd_ctl_probe (id uuid, tenant_id uuid) ON COMMIT DROP`.execute(
          trx,
        );
        await sql`CREATE TRIGGER ctl_probe AFTER DELETE ON zvd_ctl_probe
                  REFERENCING OLD TABLE AS zv_old_rows
                  FOR EACH STATEMENT EXECUTE FUNCTION public.zveltio_sync_tombstone()`.execute(trx);
        await sql`INSERT INTO zvd_ctl_probe VALUES (${row}::uuid, ${victim}::uuid)`.execute(trx);
        await sql`DELETE FROM zvd_ctl_probe`.execute(trx);
      });
    } catch (err) {
      result = (err as Error).message;
    } finally {
      await temp('REVOKE').execute(db);
    }
    const forged = await asTenant(db, victim, async (trx) => {
      const r = await sql<{ collection: string }>`
        DELETE FROM zv_sync_tombstones WHERE row_id = ${row}::uuid RETURNING collection`.execute(
        trx,
      );
      return r.rows.map((x) => x.collection);
    });
    expect(forged).toEqual([]);
    expect(result).toMatch(/permission denied for function/i);
  });
});
