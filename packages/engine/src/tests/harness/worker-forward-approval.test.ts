// A worker extension's manifest `forwardCredentials` is its own claim. The
// engine used to forward whatever it named; now its worker is handed the
// caller's credentials only on what an operator approved (migration 070):
//
//   - installed without an approval, a route that asks for `authorization` gets
//     none, and still answers;
//   - approved through approve-forward-credentials (or the install body), it
//     gets exactly the approved headers on the approved route;
//   - an upgrade that asks for one header more forwards nothing until approved
//     again; one that asks for less keeps its approval.
//
// Process transport, behind the real `/ext/*` chain, installed and approved
// through the marketplace routes.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { _resetCatalogForTests } from '../../lib/extensions/extension-catalog.js';
import { _resetCatalogCacheForTests } from '../../lib/extensions/extension-download.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `fwdappr${String(Date.now()).slice(-7)}`;
const HEADERS = ['cookie', 'authorization', 'x-api-key'];
const CREDS = {
  cookie: 'better-auth.session_token=caller',
  authorization: 'Bearer caller-token',
  'x-api-key': 'caller-api-key',
};
const NONE = { cookie: null, authorization: null, 'x-api-key': null };

const entry = `
const seen = (c) => Object.fromEntries(${JSON.stringify(HEADERS)}.map((h) => [h, c.req.header(h) ?? null]));
export default {
  name: '${NAME}',
  mountStrategy: 'subapp',
  async register(app) {
    app.post('/hook', (c) => c.json(seen(c)));
    app.post('/fwd', (c) => c.json(seen(c)));
  },
};
`;

d('credential forwarding needs an operator approval of the exact set', () => {
  let db: Database;
  let engine: Hono;
  let god = '';
  let base = '';
  const app = new Hono();
  const saved = {
    transport: process.env.ZVELTIO_EXT_TRANSPORT,
    extDir: process.env.EXTENSIONS_DIR,
    ctx: extensionLoader.ctx,
  };
  let ctx: never;

  const writeManifest = (forwardCredentials: Record<string, string[]>) =>
    writeFileSync(
      join(base, NAME, 'manifest.json'),
      JSON.stringify({
        name: NAME,
        version: '1.0.0',
        publicRoutes: ['/hook', '/fwd'],
        forwardCredentials,
        engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
      }),
    );

  /** Restart the worker from the manifest on disk, as an enable or a boot does. */
  const reload = async () => {
    await extensionLoader.unload(NAME).catch(() => undefined);
    await extensionLoader.loadExtension(NAME, app, ctx, base);
    expect(extensionLoader.getLastLoadError(NAME)).toBeUndefined();
  };

  const seen = async (path: string) => {
    const r = await app.request(`/ext/${NAME}${path}`, { method: 'POST', headers: CREDS });
    return { status: r.status, body: (await r.json().catch(() => null)) as unknown };
  };

  const market = async (action: string, body: unknown, cookie = god) => {
    const r = await engine.request(`/api/marketplace/${NAME}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    return {
      status: r.status,
      body: (await r.json().catch(() => null)) as Record<string, unknown>,
    };
  };

  const stored = async () =>
    (
      await sql<{ a: unknown }>`SELECT approved_forward_credentials AS a FROM zv_extension_registry
                                WHERE name = ${NAME} AND tenant_id IS NULL`.execute(db)
    ).rows[0]?.a;

  beforeAll(async () => {
    const t = await getTestApp();
    engine = t.app;
    db = t.db;
    god = await createGodSession(engine, db);

    base = mkdtempSync(join(tmpdir(), 'fwd-appr-'));
    process.env.EXTENSIONS_DIR = base;
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    _resetCatalogForTests();
    _resetCatalogCacheForTests();
    writeFileSync(
      join(base, 'catalog.json'),
      JSON.stringify({
        catalog_version: 'test',
        entries: [
          {
            name: NAME,
            displayName: NAME,
            category: 'other',
            version: '1.0.0',
            author: 'someone-else',
            description: 'forward approval fixture',
            is_official: false,
            publisher_tier: 'community',
          },
        ],
      }),
    );
    mkdirSync(join(base, NAME, 'engine'), { recursive: true });
    writeFileSync(join(base, NAME, 'engine', 'index.js'), entry);
    writeManifest({ '/fwd': ['authorization'] });

    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    _resetWorkerHostForTests();
    getWorkerHost(app);
    ctx = {
      ...(extensionLoader.ctx ?? {}),
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as never;
    extensionLoader.ctx = ctx;
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
  }, 60_000);

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    for (const [k, v] of [
      ['ZVELTIO_EXT_TRANSPORT', saved.transport],
      ['EXTENSIONS_DIR', saved.extDir],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetCatalogForTests();
    extensionLoader.ctx = saved.ctx;
    _resetWorkerHostForTests();
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('install without an approval succeeds, records none and reports it pending', async () => {
    const ins = await market('install', {});
    expect(ins.status).toBe(200);
    expect(ins.body.pending_forward_credentials).toEqual(['/fwd: authorization']);
    expect(await stored()).toBeNull();
  });

  it('unapproved: the route answers and its worker gets no credential', async () => {
    await reload();
    expect(await seen('/fwd')).toEqual({ status: 200, body: NONE });
  });

  it('approval is god-only, must name a map, and only what the manifest declares', async () => {
    const ok = { forward_credentials: { '/fwd': ['authorization'] } };
    expect((await market('approve-forward-credentials', ok, '')).status).toBe(401);
    expect((await market('approve-forward-credentials', {})).status).toBe(400);
    for (const wider of [{ '/fwd': ['authorization', 'cookie'] }, { '/hook': ['authorization'] }]) {
      expect(
        (await market('approve-forward-credentials', { forward_credentials: wider })).status,
      ).toBe(409);
    }
    expect(await stored()).toBeNull();
  });

  it('approved: exactly the approved header, only on the approved route', async () => {
    const r = await market('approve-forward-credentials', {
      forward_credentials: { '/fwd': ['authorization'] },
    });
    expect(r.status).toBe(200);
    expect(r.body.pending_forward_credentials).toEqual([]);
    await reload();
    expect(await seen('/fwd')).toEqual({
      status: 200,
      body: { ...NONE, authorization: 'Bearer caller-token' },
    });
    expect(await seen('/hook')).toEqual({ status: 200, body: NONE });
  });

  it('an upgrade asking for one header more forwards nothing until approved again', async () => {
    writeManifest({ '/fwd': ['authorization', 'x-api-key'] });
    await reload();
    expect(await seen('/fwd')).toEqual({ status: 200, body: NONE });

    expect(
      (
        await market('approve-forward-credentials', {
          forward_credentials: { '/fwd': ['authorization', 'x-api-key'] },
        })
      ).status,
    ).toBe(200);
    await reload();
    expect(await seen('/fwd')).toEqual({
      status: 200,
      body: { ...NONE, authorization: 'Bearer caller-token', 'x-api-key': 'caller-api-key' },
    });
  });

  it('a version asking for less keeps its approval', async () => {
    writeManifest({ '/fwd': ['authorization'] });
    await reload();
    expect(await seen('/fwd')).toEqual({
      status: 200,
      body: { ...NONE, authorization: 'Bearer caller-token' },
    });
  });

  it('install records the approval it carries, refuses an undeclared one, and none resets it', async () => {
    const wider = await market('install', { forward_credentials: { '/fwd': ['cookie'] } });
    expect(wider.status).toBe(409);
    const ins = await market('install', { forward_credentials: { '/fwd': ['authorization'] } });
    expect(ins.status).toBe(200);
    expect(ins.body.pending_forward_credentials).toEqual([]);
    expect(await stored()).toEqual({ '/fwd': ['authorization'] });
    expect((await market('install', {})).status).toBe(200);
    expect(await stored()).toBeNull();
    await reload();
    expect(await seen('/fwd')).toEqual({ status: 200, body: NONE });
  });
});
