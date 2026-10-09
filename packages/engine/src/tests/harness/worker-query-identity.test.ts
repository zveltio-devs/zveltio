// A worker-isolated extension's query runs as the USER of the request it
// serves, not only as its tenant.
//
// The host recorded the tenant of every invocation it dispatched and nothing
// else. So a worker query — and a service call it made — ran in the right
// tenant with no identity: `zveltio.actor` was never `on`, every row rule keyed
// on the caller stood down, and the worker saw what an anonymous caller of that
// tenant sees. Here: an owner rule on the collection hides `theirs` from user
// U1; an inline extension's `ctx.db` honours it, a worker's did not.
//
// Driven through a real worker and the real runtime, inside the tenant
// transaction `tenantMiddleware` opens for a signed-in user.
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
import {
  applyRowRulePolicy,
  applyTenantRLS,
  type RlsIdentity,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { createRequestScopedDb, runWithDomain } from '../../lib/tenancy/tenant-context.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const COLLECTION = `wkrid_${SFX}`;
const TABLE = `zvd_${COLLECTION}`;
const WORKER = `wkrid${SFX}`;
const CALLER = `wkridc${SFX}`;
const INLINE_SVC = `inlid${SFX}.rows`;
const B = crypto.randomUUID();
const U1 = `user-${SFX}-1`;
const IDENTITY: RlsIdentity = {
  userId: U1,
  email: 'u1@example.test',
  role: 'member',
  roles: ['member'],
  bypass: false,
  // What tenantMiddleware publishes for a member who may read it (R1).
  collectionGrants: `,${COLLECTION}:read,`,
};

const ENTRY = `
export default {
  name: '${WORKER}',
  async register(app, ctx) {
    app.get('/rows', async (c) => {
      try {
        const rows = await ctx.db.query('SELECT title FROM ${TABLE} ORDER BY title');
        const u = await ctx.db.query("SELECT current_setting('zveltio.user_id', true) AS u");
        return c.json({ ok: true, rows, user: u[0]?.u || null });
      } catch (e) { return c.json({ ok: false, error: e.message }, 500); }
    });
    ctx.services.register('${WORKER}.rows', () =>
      ctx.db.query('SELECT title FROM ${TABLE} ORDER BY title'),
    );
    app.get('/inline-svc', async (c) => {
      try {
        return c.json({ ok: true, out: await ctx.services.get('${INLINE_SVC}')() });
      } catch (e) { return c.json({ ok: false, error: e.message }, 500); }
    });
  },
};
`;

const CALLER_ENTRY = `
export default {
  name: '${CALLER}',
  async register(app, ctx) {
    app.get('/fwd', async (c) => {
      try {
        // Opens the request's transaction as this extension: the service's
        // statements join it, switched to the callee's role (RFC step 8).
        await ctx.db.query('SELECT 1');
        return c.json({ ok: true, rows: await ctx.services.get('${WORKER}.rows')() });
      } catch (e) { return c.json({ ok: false, error: e.message }, 500); }
    });
  },
};
`;

function writeWorker(base: string, name: string, entry: string, deps: string[]): void {
  const dir = join(base, name);
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      // The broker lets a worker call only what it declared.
      dependencies: deps.map((n) => ({ name: n })),
      engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), entry);
}

d("a worker query runs as its request's user", () => {
  let db: Database;
  let base = '';
  const workerApp = new Hono();

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${B}::uuid, ${`wkrid-${SFX}`}, 'b', 'active')`.execute(db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'owner', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    await applyTenantRLS(db, TABLE);
    await sql`INSERT INTO ${sql.table(TABLE)} (title, owner, tenant_id) VALUES
                ('mine', ${U1}, ${B}::uuid), ('theirs', 'someone-else', ${B}::uuid)`.execute(db);
    await sql`INSERT INTO zvd_rls_policies
                (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
              VALUES (${COLLECTION}, '*', 'owner', 'eq', 'user_id', true)`.execute(db);
    await applyRowRulePolicy(db, COLLECTION);

    base = mkdtempSync(join(tmpdir(), 'wkr-id-'));
    writeWorker(base, WORKER, ENTRY, ['inlid']);
    writeWorker(base, CALLER, CALLER_ENTRY, [WORKER]);
    // 'inlid' stands in for the inline extension that owns INLINE_SVC.
    extensionLoader.loaded.set('inlid', { name: 'inlid' } as never);
    serviceRegistry.registerAs('inlid', INLINE_SVC, async () =>
      createRequestScopedDb(db)
        .selectFrom(TABLE as never)
        .select('title' as never)
        .orderBy('title' as never)
        .execute(),
    );
    _resetWorkerHostForTests();
    // What tenantMiddleware does for a signed-in user of tenant B.
    workerApp.use('*', (c, next) =>
      runWithDomain(B, () =>
        withTenantIsolation(
          B,
          async () => {
            c.set('tenant' as never, { id: B } as never);
            await next();
          },
          { userId: null, identity: IDENTITY },
        ),
      ),
    );
    getWorkerHost(workerApp);
    const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
    await extensionLoader.loadExtension(WORKER, workerApp, ctx, base);
    expect(extensionLoader.getLastLoadError(WORKER)).toBeUndefined();
    await extensionLoader.loadExtension(CALLER, workerApp, ctx, base);
    expect(extensionLoader.getLastLoadError(CALLER)).toBeUndefined();
  }, 60_000);

  afterAll(async () => {
    await getWorkerHost(workerApp).stopAll();
    serviceRegistry.unregisterAll('inlid');
    extensionLoader.loaded.delete('inlid');
    _resetWorkerHostForTests();
    if (base) rmSync(base, { recursive: true, force: true });
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => undefined);
    await DDLManager.dropCollection(db, COLLECTION).catch(() => undefined);
    await sql`DELETE FROM zv_tenants WHERE id = ${B}::uuid`.execute(db).catch(() => undefined);
    await revokeExtensionDbRoles(db, WORKER, true).catch(() => undefined);
    await revokeExtensionDbRoles(db, CALLER, true).catch(() => undefined);
  });

  it('is held to a row rule keyed on the user, and sees who that user is', async () => {
    const res = await workerApp.request(`/ext/${WORKER}/rows`);
    // Before: { rows: [mine, theirs], user: null } — the owner rule stood down.
    expect(await res.json()).toEqual({ ok: true, rows: [{ title: 'mine' }], user: U1 });
  });

  it('an inline service the worker calls runs as the user', async () => {
    const res = await workerApp.request(`/ext/${WORKER}/inline-svc`);
    expect(await res.json()).toEqual({ ok: true, out: [{ title: 'mine' }] });
  });

  it("a worker's service called by another worker queries as the user", async () => {
    const res = await workerApp.request(`/ext/${CALLER}/fwd`);
    expect(await res.json()).toEqual({ ok: true, rows: [{ title: 'mine' }] });
  });

  it("a worker's service called by an inline caller queries as that caller", async () => {
    const svc = serviceRegistry.get<() => Promise<unknown>>(`${WORKER}.rows`);
    const rows = await runWithDomain(B, () =>
      withTenantIsolation(B, () => svc!() as Promise<unknown>, {
        userId: null,
        identity: IDENTITY,
      }),
    );
    expect(rows).toEqual([{ title: 'mine' }]);
  });

  it('work with no identity gets no collection: an extension needs an actor (R1)', async () => {
    const svc = serviceRegistry.get<() => Promise<unknown>>(`${WORKER}.rows`);
    const rows = await runWithDomain(B, () =>
      withTenantIsolation(B, () => svc!() as Promise<unknown>),
    );
    // Before R1 the owner rule stood down and both rows came back.
    expect(rows).toEqual([]);
  });
});
