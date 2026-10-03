/**
 * The narrow roles hold exactly the tenant-isolated collection tables.
 *
 * `zveltio_worker` (worker SQL bridge) and `zveltio_flow_reader` (flow
 * `query_db`) are meant to reach collections and nothing else of the engine's.
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
 * Driven the way a worker's `ctx.db` reaches the database: `db:query` on the
 * host, the real pool, `SET LOCAL ROLE zveltio_worker`, the request's tenant.
 * The collection is created by the real road (the route and its DDL job).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { reconcileTenantRLS } from '../../lib/tenancy/index.js';
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
} from '../../lib/worker-extension-protocol.js';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const COLL = `wkr_grant_${Date.now().toString(36)}`;
const TABLE = `zvd_${COLL}`;
const TENANT_A = '00000000-0000-0000-0000-00000000a0a1';
const TENANT_B = '00000000-0000-0000-0000-00000000b0b1';
const PROBE = `wkr-grant-probe-${Date.now()}`;

type Reply = { ok: true; rows: unknown[] } | { ok: false; error: string };

/** One `db:query` through the host, as a worker request under `tenantId` sends it. */
async function workerQuery(sqlText: string, tenantId: string): Promise<Reply> {
  const host = new WorkerExtensionHost(new Hono());
  const reply = await new Promise<HostToWorkerMessage>((resolve) => {
    const managed = {
      name: 'grant-probe',
      worker: { postMessage: resolve, terminate: () => {} },
      invokeTenants: new Map([['req-1', tenantId]]),
      pendingInvokes: new Map(),
      pendingInits: new Map(),
      pendingPings: new Map(),
      registeredServices: new Set<string>(),
      routes: [],
    };
    _internalForTests.dispatchMessage(
      host,
      managed as never,
      {
        type: 'db:query',
        id: 'q-1',
        requestId: 'req-1',
        sql: sqlText,
        params: [],
      } as WorkerToHostMessage,
    );
  });
  if (reply.type === 'db:ok') return { ok: true, rows: reply.rows as unknown[] };
  return { ok: false, error: reply.type === 'db:err' ? String(reply.error) : reply.type };
}

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

/** What flow-executor does around a `query_db` step. */
async function asQueryDbStep(db: Database, query: string, tenantId: string) {
  return db.transaction().execute(async (trx) => {
    await sql.raw('SET TRANSACTION READ ONLY').execute(trx);
    await sql.raw('SET LOCAL ROLE zveltio_flow_reader').execute(trx);
    await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);
    return (await sql.raw(query).execute(trx)).rows;
  });
}

/** Run `fn` with `zveltio_worker` missing, as on a Postgres where 001 could not create it. */
async function withoutWorkerRole<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  await sql.raw('ALTER ROLE zveltio_worker RENAME TO zveltio_worker_hidden_probe').execute(db);
  try {
    return await fn();
  } finally {
    await sql.raw('ALTER ROLE zveltio_worker_hidden_probe RENAME TO zveltio_worker').execute(db);
  }
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
    await sql`INSERT INTO ${sql.id(TABLE)} (title, tenant_id) VALUES
      ('a-row', ${TENANT_A}::uuid), ('b-row', ${TENANT_B}::uuid)`.execute(db);
  }, 60_000);

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${PROBE}`.execute(db);
    await DDLManager.dropCollection(db, COLL).catch(() => undefined);
  });

  it('a collection created after install carries exactly the 001 grant', async () => {
    expect(await workerPrivileges(db, TABLE)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('a worker reads the new collection — its own tenant only', async () => {
    // As the narrow role, not the fallback: `zveltio_rls` also holds `user`.
    expect(await workerQuery('SELECT current_user AS u', TENANT_A)).toEqual({
      ok: true,
      rows: [{ u: 'zveltio_worker' }],
    });
    expect(await workerQuery(`SELECT title FROM ${TABLE} ORDER BY title`, TENANT_A)).toEqual({
      ok: true,
      rows: [{ title: 'a-row' }],
    });
  });

  it('a worker write lands in its own tenant and cannot be aimed at another', async () => {
    const own = await workerQuery(
      `INSERT INTO ${TABLE} (title) VALUES ('a-two') RETURNING tenant_id`,
      TENANT_A,
    );
    expect(own).toEqual({ ok: true, rows: [{ tenant_id: TENANT_A }] });
    const cross = await workerQuery(
      `INSERT INTO ${TABLE} (title, tenant_id) VALUES ('x', '${TENANT_B}')`,
      TENANT_A,
    );
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.error).toMatch(/row-level security/i);
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

  it('without zveltio_worker the bridge falls back to zveltio_rls — and still cannot write Casbin', async () => {
    const res = await withoutWorkerRole(db, async () => ({
      who: await workerQuery('SELECT current_user AS u', TENANT_A),
      write: await workerQuery(
        `INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES ('g', '${PROBE}', 'god', '*')`,
        TENANT_A,
      ),
    }));
    // The fallback really happened, so the refusal below is the policy's.
    expect(res.who).toEqual({ ok: true, rows: [{ u: 'zveltio_rls' }] });
    expect(res.write.ok).toBe(false);
    if (!res.write.ok) expect(res.write.error).toContain('zvd_permissions');
    const written = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zvd_permissions WHERE v0 = ${PROBE}
    `.execute(db);
    expect(written.rows[0]!.n).toBe(0);
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

  it('a collection created before isolation is on it is reachable to neither role until it is', async () => {
    // `DDLManager.createCollection` is also an extension's `ctx.ddl` road, which
    // applies no RLS: until the boot reconcile, such a table has none. The flow
    // reader used to be granted at CREATE TABLE, so a `query_db` step read every
    // tenant's rows there.
    const name = `${COLL}_ctx`;
    const t = `zvd_${name}`;
    await DDLManager.createCollection(db, {
      name,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    try {
      expect(await privileges(db, t, 'zveltio_flow_reader')).toEqual([]);
      expect(await workerPrivileges(db, t)).toEqual([]);
      await reconcileTenantRLS(db);
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
