// A worker-isolated extension's query runs as the tenant of the request it
// serves.
//
// The host keeps its own record of every route invocation it dispatches
// (`invokeTenants`) and reads a query's tenant from it, by the `requestId` the
// query names — never from what the worker claims. The worker runtime never
// sent that id. So the record was never consulted, every worker query ran with
// no tenant, and the isolation predicate answered for the default tenant: a
// worker extension serving tenant B read and wrote the default tenant's rows.
//
// Driven through a real worker and the real runtime, as a request for tenant B.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { applyTenantRLS } from '../../lib/tenancy/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const COLLECTION = `wkrten_${SFX}`;
const TABLE = `zvd_${COLLECTION}`;
const WORKER = `wkrten${SFX}`;
const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';
const B = crypto.randomUUID();

const ENTRY = `
export default {
  name: '${WORKER}',
  async register(app, ctx) {
    app.get('/rows', async (c) => {
      try {
        const rows = await ctx.db.query('SELECT title FROM ${TABLE} ORDER BY title');
        const t = await ctx.db.query("SELECT current_setting('zveltio.current_tenant', true) AS t");
        return c.json({ ok: true, rows, tenant: t[0]?.t ?? null });
      } catch (e) { return c.json({ ok: false, error: e.message }, 500); }
    });
    // Work the route starts and does not wait for: it runs after the
    // invocation is over, still inside the route's async context.
    let late = null;
    app.get('/later', (c) => {
      late = null;
      setTimeout(() => {
        ctx.db.query('SELECT title FROM ${TABLE} ORDER BY title').then(
          (rows) => { late = { ok: true, rows }; },
          (e) => { late = { ok: false, error: e.message }; },
        );
      }, 100);
      return c.json({ started: true });
    });
    app.get('/late', (c) => c.json(late));
  },
};
`;

d('a worker query runs as the tenant of its request', () => {
  let db: Database;
  let base = '';
  const workerApp = new Hono();

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${B}::uuid, ${`wkrten-${SFX}`}, 'b', 'active')`.execute(db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await applyTenantRLS(db, TABLE);
    await sql`INSERT INTO ${sql.table(TABLE)} (title, tenant_id) VALUES
                ('default-row', ${DEFAULT_TENANT}::uuid), ('b-row', ${B}::uuid)`.execute(db);

    base = mkdtempSync(join(tmpdir(), 'wkr-ten-'));
    const dir = join(base, WORKER);
    mkdirSync(join(dir, 'engine'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: WORKER,
        version: '1.0.0',
        engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
      }),
    );
    writeFileSync(join(dir, 'engine', 'index.js'), ENTRY);
    _resetWorkerHostForTests();
    // What tenantMiddleware sets for a request to tenant B.
    workerApp.use('*', async (c, next) => {
      c.set('tenant' as never, { id: B } as never);
      await next();
    });
    getWorkerHost(workerApp);
    const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
    await extensionLoader.loadExtension(WORKER, workerApp, ctx, base);
    expect(extensionLoader.getLastLoadError(WORKER)).toBeUndefined();
  }, 60_000);

  afterAll(async () => {
    await getWorkerHost(workerApp).stopAll();
    _resetWorkerHostForTests();
    if (base) rmSync(base, { recursive: true, force: true });
    await DDLManager.dropCollection(db, COLLECTION).catch(() => undefined);
    await sql`DELETE FROM zv_tenants WHERE id = ${B}::uuid`.execute(db).catch(() => undefined);
    await revokeExtensionDbRoles(db, WORKER, true).catch(() => undefined);
  });

  it("reads its request's tenant rows, not the default tenant's", async () => {
    const res = await workerApp.request(`/ext/${WORKER}/rows`);
    const out = (await res.json()) as { ok: boolean; rows?: { title: string }[]; tenant?: string };
    expect(out).toEqual({ ok: true, rows: [{ title: 'b-row' }], tenant: B });
  });

  it('refuses a query issued after its request is over, rather than run it as the default tenant', async () => {
    await workerApp.request(`/ext/${WORKER}/later`);
    type Late = { ok: boolean; rows?: unknown[]; error?: string } | null;
    let late: Late = null;
    for (let i = 0; i < 50 && !late; i++) {
      await Bun.sleep(50);
      late = (await (await workerApp.request(`/ext/${WORKER}/late`)).json()) as Late;
    }
    // Before: { ok: true, rows: [{ title: 'default-row' }] } — tenant B's
    // leftover work read (and could write) the default tenant's rows.
    expect(late).toEqual({ ok: false, error: expect.stringContaining('is over') });
  });
});
