/**
 * The narrow roles hold exactly the tenant-isolated collection tables.
 *
 * `zveltio_worker` (worker SQL bridge) and `zveltio_flow_reader` (flow
 * `query_db`, removed by ADR 0058; the role stays until it is retired) are meant
 * to reach collections and nothing else of the engine's.
 *
 * The worker SQL bridge runs every query of a worker-isolated extension as
 * `zveltio_worker`. Migration 001 granted it DML on every `zvd_%` table present
 * when it ran and said new ones were granted at create time — by a function
 * that was never written; `ALTER DEFAULT PRIVILEGES` names `zveltio_rls` only.
 * Measured before the fix, through the real bridge:
 *
 *   - a collection created after install → `permission denied for table zvd_…`
 *   - `INSERT INTO zvd_permissions …` (the Casbin policy table, which shares the
 *     prefix and has no RLS) → ALLOWED: an extension could grant itself `god`.
 *
 * No SQL crosses from a worker any more (RFC extension-model-v3 decision 2), so
 * the bridge cases went with it; the role's grants are held here until it is
 * retired. The collection is created by the real road (the route and its DDL job).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { DEFAULT_TENANT_ID, reconcileTenantRLS } from '../../lib/tenancy/index.js';
import {
  asTenant,
  createGodSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const COLL = `wkr_grant_${Date.now().toString(36)}`;
const TABLE = `zvd_${COLL}`;
const TENANT_A = '00000000-0000-0000-0000-00000000a0a1';
const TENANT_B = '00000000-0000-0000-0000-00000000b0b1';
const PROBE = `wkr-grant-probe-${Date.now()}`;

async function privileges(db: Database, table: string, role: string): Promise<string[]> {
  const r = await sql<{ p: string }>`
    SELECT privilege_type AS p FROM information_schema.role_table_grants
     WHERE grantee = ${role} AND table_schema = 'public' AND table_name = ${table}
     ORDER BY 1
  `.execute(db);
  return r.rows.map((x) => x.p);
}

const workerPrivileges = (db: Database, table: string) => privileges(db, table, 'zveltio_worker');

/**
 * The `zvd_%` grant migration 001 made, put back so the reconcile has something
 * to take: on a database an earlier boot already healed, a reconcile that
 * revokes nothing would pass.
 */
async function grantAs001(db: Database, tables: string[], role: string, privs: string) {
  for (const t of tables) {
    await sql`GRANT ${sql.raw(privs)} ON ${sql.id(t)} TO ${sql.id(role)}`.execute(db);
    expect(await privileges(db, t, role)).not.toEqual([]);
  }
}

/** What flow-executor did around a `query_db` step (removed, ADR 0058). */
async function asQueryDbStep(db: Database, query: string, tenantId: string) {
  return db.transaction().execute(async (trx) => {
    await sql.raw('SET TRANSACTION READ ONLY').execute(trx);
    await sql.raw('SET LOCAL ROLE zveltio_flow_reader').execute(trx);
    await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);
    return (await sql.raw(query).execute(trx)).rows;
  });
}

d('the narrow roles hold exactly the collection tables', () => {
  let db: Database;

  beforeAll(async () => {
    let app: Hono;
    ({ app, db } = await getTestApp());
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
    // The DDL job creates the table, then isolates it, then grants the narrow
    // roles (applyTenantRLS). Wait for those grants — the last thing the job
    // does to the table — not for a duration.
    for (let i = 0; i < 150; i++) {
      const seen = await sql<{ ok: boolean }>`
        SELECT CASE WHEN to_regclass(${TABLE}) IS NULL THEN false
                    ELSE has_table_privilege('zveltio_worker', ${TABLE}, 'DELETE')
                     AND has_table_privilege('zveltio_flow_reader', ${TABLE}, 'SELECT') END AS ok
      `.execute(db);
      if (seen.rows[0]!.ok) break;
      await Bun.sleep(100);
    }
    // Seeded as the owner, one row per tenant; the worker must see only its own.
    for (const [title, tenant] of [
      ['a-row', TENANT_A],
      ['b-row', TENANT_B],
      ['default-row', DEFAULT_TENANT_ID],
    ]) {
      await asTenant(db, tenant!, (trx) =>
        sql`INSERT INTO ${sql.id(TABLE)} (title, tenant_id) VALUES (${title}, ${tenant}::uuid)`.execute(
          trx,
        ),
      );
    }
  }, 60_000);

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${PROBE}`.execute(db);
    await DDLManager.dropCollection(db, COLL).catch(() => undefined);
  });

  it('a collection created after install carries exactly the 001 grant', async () => {
    expect(await workerPrivileges(db, TABLE)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('the boot reconcile heals a collection an older engine left ungranted', async () => {
    await sql`REVOKE ALL ON ${sql.id(TABLE)} FROM zveltio_worker`.execute(db);
    expect(await workerPrivileges(db, TABLE)).toEqual([]);
    await reconcileTenantRLS(db);
    expect(await workerPrivileges(db, TABLE)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  }, 60_000);

  it('the boot reconcile takes the engine metadata tables back — no Casbin write', async () => {
    const metadata = ['zvd_permissions', 'zvd_collections', 'zvd_rls_policies', 'zvd_webhooks'];
    await grantAs001(db, metadata, 'zveltio_worker', 'SELECT, INSERT, UPDATE, DELETE');
    await reconcileTenantRLS(db);
    for (const t of metadata) {
      expect({ t, p: await workerPrivileges(db, t) }).toEqual({ t, p: [] });
    }
    // The database layer on its own, beneath the bridge's string policy.
    await expect(
      db.transaction().execute(async (trx) => {
        await sql.raw('SET LOCAL ROLE zveltio_worker').execute(trx);
        await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2)
                  VALUES ('g', ${PROBE}, 'god', '*')`.execute(trx);
      }),
    ).rejects.toThrow(/permission denied for table zvd_permissions/);
  }, 60_000);

  it('the flow reader holds SELECT on the new collection and reads its own tenant only', async () => {
    expect(await privileges(db, TABLE, 'zveltio_flow_reader')).toEqual(['SELECT']);
    const rows = await asQueryDbStep(
      db,
      `SELECT title FROM ${TABLE} WHERE title LIKE '_-row' ORDER BY 1`,
      TENANT_B,
    );
    expect(rows).toEqual([{ title: 'b-row' }]);
  });

  it('the boot reconcile takes the engine metadata tables back from the flow reader', async () => {
    const metadata = ['zvd_webhooks', 'zvd_push_tokens', 'zvd_permissions', 'zvd_rls_policies'];
    await grantAs001(db, metadata, 'zveltio_flow_reader', 'SELECT');
    await reconcileTenantRLS(db);
    for (const t of metadata) {
      expect({ t, p: await privileges(db, t, 'zveltio_flow_reader') }).toEqual({ t, p: [] });
    }
    await expect(asQueryDbStep(db, 'SELECT * FROM zvd_webhooks', TENANT_A)).rejects.toThrow(
      /permission denied for table zvd_webhooks/,
    );
  }, 60_000);

  it('a collection created through DDLManager holds the grants with isolation already on', async () => {
    // `DDLManager.createCollection` is also an extension's `ctx.ddl` road. It
    // used to apply no RLS, so the table waited for the boot reconcile; the
    // flow reader, granted at CREATE TABLE, read every tenant's rows there. The
    // table and its isolation now commit together, grants last.
    const name = `${COLL}_ctx`;
    const t = `zvd_${name}`;
    await DDLManager.createCollection(db, {
      name,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    try {
      const r = await sql<{ force: boolean }>`
        SELECT relforcerowsecurity AS force FROM pg_class WHERE oid = to_regclass(${t})
      `.execute(db);
      expect(r.rows[0]?.force).toBe(true);
      expect(await privileges(db, t, 'zveltio_flow_reader')).toEqual(['SELECT']);
      expect(await workerPrivileges(db, t)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    } finally {
      await DDLManager.dropCollection(db, name).catch(() => undefined);
    }
  }, 60_000);
});
