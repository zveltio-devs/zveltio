/**
 * ADR 0039 slice 1: a route is declared in the manifest and answered by a plain
 * function, `(request, { params, host }) => Response`.
 *
 * Through the engine's own `/ext/*` chain (session, tenant, gate) and the real
 * load path (`finalizeExtensionLoad`), for an inline extension and for one
 * isolated in a worker over the runner protocol (`process` transport): a
 * `public` route answers without a session, a `caller` route is authenticated as
 * every extension route, a path not declared does not exist, and `publicRoutes`
 * still opens a route as a deprecated alias. The gate decides a request's access
 * by the declared route it resolves to, method and path: a public pattern opens
 * no other method of its path, no `caller` route it overlaps, and no action.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { RouteHandler, ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { jobQueueName, unregisterJobs } from '../../lib/extensions/jobs.js';
import { getAuth } from '../../lib/auth.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { toJsonb } from '../../lib/jsonb.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = String(Date.now()).slice(-7);
const EXT = `drt-ext-${STAMP}`;
const WEXT = `drtw${STAMP}`;
const BAD = `drtb${STAMP}`;
const RES = `drt_res_${STAMP}`;

type Rec = Record<string, unknown>;

const routes = [
  { method: 'POST', path: '/hook/:id', access: 'public', handler: 'hook' },
  // Same shape as the public one, another method: authenticated.
  { method: 'GET', path: '/hook/x', access: 'caller', handler: 'mine' },
  { method: 'GET', path: '/me', access: 'caller', handler: 'mine' },
];

const hook: RouteHandler = async (request, { params, host }) =>
  Response.json({
    id: params.id,
    url: request.url,
    method: request.method,
    body: await request.text(),
    host: Object.keys(host).sort(),
    job: host.enqueue ? await host.enqueue('ingest', { id: params.id }) : null,
  });

const workerEntry = `
export default {
  name: '${WEXT}',
  mountStrategy: 'subapp',
  routes: {
    hook: async (request, { params, host }) => Response.json({
      id: params.id, url: request.url, method: request.method,
      body: await request.text(), host: Object.keys(host).sort(),
    }),
    mine: () => Response.json({ mine: true }),
  },
  async register(app) {
    app.get('/legacy', (c) => c.text('legacy'));
  },
};
`;
/** Names a handler its module does not export. */
const badEntry = `export default { name: '${BAD}', routes: {}, async register() {} };`;

d('a declared route answered by a plain function (ADR 0039)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let god = '';
  let member = '';
  let base = '';
  const saved = { transport: process.env.ZVELTIO_EXT_TRANSPORT };

  function loader(ctx: ExtensionContext): ExtensionLoader {
    return {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
  }
  async function load(ext: ZveltioExtension, manifest: Rec, dir = `/tmp/${ext.name}`) {
    const parsed = ManifestSchema.parse({ name: ext.name, version: '1.0.0', ...manifest });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${ext.name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${ext.name}, ${ext.name}, NULL, true, true, ${toJsonb(parsed)})
    `.execute(db);
    const ctx = {
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as unknown as ExtensionContext;
    await finalizeExtensionLoad(
      loader(ctx),
      ext,
      ext.name,
      dir,
      app,
      ctx,
      parsed as never,
      new Set(),
    );
  }
  const call = (ext: string, path: string, method = 'GET', cookie?: string, body?: string) =>
    app.request(`/ext/${ext}${path}`, {
      method,
      headers: { 'content-type': 'text/plain', ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body }),
    });

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    god = await createGodSession(engine, db);
    member = (await createMemberSession(engine, db, {})).cookie;
    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    _resetWorkerHostForTests();
    getWorkerHost(app);

    await load(
      {
        name: EXT,
        category: 'custom',
        mountStrategy: 'subapp',
        routes: {
          hook,
          mine: () => Response.json({ mine: true }),
          any: (_r, { params }) => Response.json({ any: params }),
        },
        actions: { noop: async () => 'ran' },
        jobs: { ingest: async () => {} },
        async register(r) {
          (r as Hono).get('/legacy', (c) => c.text('legacy'));
        },
      },
      {
        permissions: ['data:system'],
        resources: [RES],
        publicRoutes: ['/legacy'],
        routes: [
          ...routes,
          // Two segments, so `/actions/noop` has its shape: the action stays the engine's.
          { method: 'POST', path: '/:a/:b', access: 'public', handler: 'any' },
        ],
        actions: [{ name: 'noop', permission: { resource: RES }, input: { type: 'object' } }],
        jobs: [
          {
            name: 'ingest',
            input: { type: 'object', properties: { id: { type: 'string' } } },
            fromPublicRoutes: ['/hook/:id'],
            retry: { limit: 0 },
          },
        ],
      },
    );

    base = mkdtempSync(join(tmpdir(), 'drt-'));
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    const worker = async (name: string, entry: string, manifest: Rec) => {
      mkdirSync(join(base, name, 'engine'), { recursive: true });
      writeFileSync(join(base, name, 'engine', 'index.js'), entry);
      await load(
        { name, category: 'custom', async register() {} },
        { ...manifest, engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' } },
        join(base, name),
      );
    };
    await worker(WEXT, workerEntry, { publicRoutes: ['/legacy'], routes });
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (saved.transport === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved.transport;
    for (const n of [WEXT, BAD]) {
      await getWorkerHost(app)
        .stop(n)
        .catch(() => undefined);
    }
    _resetWorkerHostForTests();
    await unregisterJobs(EXT);
    if (base) rmSync(base, { recursive: true, force: true });
    if (!db) return;
    // The refused loads leave registry rows too (`${BAD}i`, `u`, `g`); a row with no
    // manifest makes every later default grant refuse, so they all go.
    await sql`DELETE FROM zv_extension_registry
               WHERE name IN (${EXT}, ${WEXT}) OR name LIKE ${`${BAD}%`}`.execute(db);
    await sql`DELETE FROM pgboss.job WHERE name = ${jobQueueName(EXT, 'ingest')}`
      .execute(db)
      .catch(() => {});
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE resource_id LIKE ${`${EXT}:%`}`.execute(trx),
    );
  });

  for (const [label, ext] of [
    ['inline', EXT],
    ['worker', WEXT],
  ] as const) {
    it(`${label}: a public route answers without a session, with its params and the caller's URL`, async () => {
      const res = await call(ext, '/hook/42', 'POST', undefined, 'payload');
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as Rec;
      expect(body).toMatchObject({ id: '42', method: 'POST', body: 'payload' });
      expect(String(body.url)).toEndWith(`/ext/${ext}/hook/42`);
      // ADR 0039 decision 4: what a route has today, and no more.
      expect(body.host).toEqual(
        label === 'inline' ? ['collections', 'enqueue', 'files', 'identity'] : ['collections'],
      );
    }, 30_000);

    it(`${label}: a caller route is authenticated as every extension route`, async () => {
      expect((await call(ext, '/me')).status).toBe(401);
      const res = await call(ext, '/me', 'GET', member);
      expect([res.status, await res.json()]).toEqual([200, { mine: true }]);
    }, 30_000);

    it(`${label}: a public pattern opens neither another method nor a caller route of its shape`, async () => {
      // `GET /hook/x` is declared `caller`; `/hook/:id` is public for POST only.
      expect((await call(ext, '/hook/x')).status).toBe(401);
      expect((await call(ext, '/hook/x', 'GET', member)).status).toBe(200);
      // GET of the public path is declared by no route.
      expect((await call(ext, '/hook/42')).status).toBe(401);
    }, 30_000);

    it(`${label}: a path that is not declared does not exist`, async () => {
      expect((await call(ext, '/nothing', 'GET', member)).status).toBe(404);
      expect((await call(ext, '/hook/42', 'GET', member)).status).toBe(404);
      expect((await call(ext, '/hook/42/more', 'POST', member)).status).toBe(404);
      // Anonymous: refused before routing, as every undeclared extension path.
      expect((await call(ext, '/nothing')).status).toBe(401);
    }, 30_000);

    it(`${label}: publicRoutes still opens a route (deprecated alias)`, async () => {
      const res = await call(ext, '/legacy');
      expect([res.status, await res.text()]).toEqual([200, 'legacy']);
    }, 30_000);
  }

  it('inline: host.enqueue queues a job that names the declared public route', async () => {
    const res = await call(EXT, '/hook/77', 'POST', undefined, 'x');
    const { job } = (await res.json()) as { job: string };
    expect(job).toBeString();
    const rows = await asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{ route: string }>`
          SELECT metadata->>'route' AS route FROM zv_audit_log
           WHERE event_type = 'extension.job.enqueued' AND metadata->>'jobId' = ${job}`.execute(trx)
        ).rows,
    );
    expect(rows).toEqual([{ route: '/hook/77' }]);
  }, 30_000);

  it('a public pattern of the shape of /actions/<name> leaves the action to the engine', async () => {
    // Served by the declared route anywhere else.
    const other = await call(EXT, '/x/y', 'POST');
    expect([other.status, await other.json()]).toEqual([200, { any: { a: 'x', b: 'y' } }]);
    // The action route is mounted first and needs the gate's principal.
    const res = await app.request(`/ext/${EXT}/actions/noop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: god },
      body: '{}',
    });
    expect([res.status, await res.json()]).toEqual([200, { result: 'ran' }]);
    expect((await call(EXT, '/actions/noop', 'POST', undefined, '{}')).status).toBe(401);
  }, 30_000);

  it('refuses to load a route whose handler the module does not export, in either transport', async () => {
    await expect(
      load(
        { name: `${BAD}i`, category: 'custom', mountStrategy: 'subapp', async register() {} },
        { routes: [{ method: 'GET', path: '/a', access: 'caller', handler: 'ghost' }] },
      ),
    ).rejects.toThrow('names handler "ghost"');
    await expect(
      load(
        {
          name: `${BAD}u`,
          category: 'custom',
          mountStrategy: 'subapp',
          routes: { stray: () => new Response() },
          async register() {},
        },
        {},
      ),
    ).rejects.toThrow('"stray" is exported but no manifest route names it');
    await expect(
      load(
        {
          name: `${BAD}g`,
          category: 'custom',
          routes: { a: () => new Response() },
          async register() {},
        },
        { routes: [{ method: 'GET', path: '/a', access: 'caller', handler: 'a' }] },
      ),
    ).rejects.toThrow("declared routes need mountStrategy 'subapp'");
    mkdirSync(join(base, BAD, 'engine'), { recursive: true });
    writeFileSync(join(base, BAD, 'engine', 'index.js'), badEntry);
    await expect(
      load(
        { name: BAD, category: 'custom', async register() {} },
        {
          routes: [{ method: 'GET', path: '/a', access: 'caller', handler: 'ghost' }],
          engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
        },
        join(base, BAD),
      ),
    ).rejects.toThrow('names handler "ghost"');
  }, 30_000);

  it('a firm that turned the extension off gets 404 from a worker as from an inline one', async () => {
    // The worker proxy registered its routes before its activation middleware,
    // and a route answers without calling `next`: a signed-in caller of a firm
    // that switched a worker-isolated extension off was answered 200.
    expect((await call(WEXT, '/me', 'GET', member)).status).toBe(200);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${EXT}, ${EXT}, ${DEFAULT_TENANT_ID}, true, false),
             (${WEXT}, ${WEXT}, ${DEFAULT_TENANT_ID}, true, false)
    `.execute(db);
    invalidateActivationCache();
    try {
      for (const ext of [EXT, WEXT]) {
        const res = await call(ext, '/me', 'GET', member);
        expect([ext, res.status, await res.json()]).toEqual([ext, 404, { error: 'Not found' }]);
      }
    } finally {
      await sql`DELETE FROM zv_extension_registry
                 WHERE name IN (${EXT}, ${WEXT}) AND tenant_id IS NOT NULL`.execute(db);
      invalidateActivationCache();
    }
  }, 30_000);
});
