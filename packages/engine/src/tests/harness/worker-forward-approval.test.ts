// A worker extension's manifest `forwardCredentials` is its own claim. The
// engine used to forward whatever it named; now its worker is handed the
// caller's credentials only on what an operator approved (migration 070):
//
//   - installed without an approval, a route that asks for `authorization` gets
//     none, and still answers;
//   - approved through approve-forward-credentials (or the install body), it
//     gets exactly the approved headers on the approved route;
//   - an upgrade that asks for one header more forwards nothing until approved
//     again; one that asks for less keeps its approval;
//   - an approval or its withdrawal restarts the running worker at once, here
//     and, through the realtime bus, on every other replica (no reload by hand);
//   - a withdrawal wins over a worker (re)starting with the approval it read
//     just before, and over an older refresh whose read came back late;
//   - an extension the registry has no row for (ZVELTIO_EXTENSIONS,
//     ZVELTIO_EXTENSIONS_PATH) can be approved too (migration 071).
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
import { refreshForwardApproval } from '../../lib/extensions/consent.js';
import { _resetCatalogForTests } from '../../lib/extensions/extension-catalog.js';
import { _resetCatalogCacheForTests } from '../../lib/extensions/extension-download.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { engineEvents } from '../../lib/runtime/index.js';
import {
  dispatchToWs,
  EXTENSION_FORWARD_CHANGED_EVENT,
  ORIGIN_ID,
} from '../../lib/runtime/realtime-bus.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { createSteppedUpGod, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

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
      await sql<{ a: unknown }>`SELECT approved AS a FROM zv_extension_forward_approvals
                                WHERE name = ${NAME}`.execute(db)
    ).rows[0]?.a ?? null;

  beforeAll(async () => {
    const t = await getTestApp();
    engine = t.app;
    db = t.db;
    ({ cookie: god, app: engine } = await createSteppedUpGod(engine, db));

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
    // The merged registry catalog is cached for minutes and holds this file's
    // catalog.json, which leaves out every other fixture.
    _resetCatalogCacheForTests();
    extensionLoader.ctx = saved.ctx;
    _resetWorkerHostForTests();
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await sql`DELETE FROM zv_extension_forward_approvals WHERE name = ${NAME}`.execute(db);
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

  const AUTH_ONLY = { ...NONE, authorization: 'Bearer caller-token' };
  const approve = (map: Record<string, string[]>) =>
    market('approve-forward-credentials', { forward_credentials: map });

  const generation = () =>
    getWorkerHost(app)
      .getHealth()
      .find((w) => w.name === NAME)?.workerGeneration;

  it('an approval and its withdrawal reach the running worker at once', async () => {
    expect(await seen('/fwd')).toEqual({ status: 200, body: NONE });
    expect((await approve({ '/fwd': ['authorization'] })).status).toBe(200);
    expect(await seen('/fwd')).toEqual({ status: 200, body: AUTH_ONLY });
    // A withdrawal restarts the worker: whatever it kept of what it was handed goes too.
    const before = generation() ?? 0;
    expect((await approve({})).status).toBe(200);
    expect(await seen('/fwd')).toEqual({ status: 200, body: NONE });
    expect(generation()).toBe(before + 1);
    // An unchanged approval restarts nothing.
    expect((await approve({})).status).toBe(200);
    expect(generation()).toBe(before + 1);
  });

  const fromReplica = () =>
    dispatchToWs({
      originId: `${ORIGIN_ID}-other`,
      event: EXTENSION_FORWARD_CHANGED_EVENT,
      collection: NAME,
      timestamp: new Date().toISOString(),
    });
  const setApproval = (map: Record<string, string[]>) =>
    sql`INSERT INTO zv_extension_forward_approvals (name, approved)
        VALUES (${NAME}, ${JSON.stringify(map)}::jsonb)
        ON CONFLICT (name) DO UPDATE SET approved = EXCLUDED.approved`.execute(db);

  it("another replica's change arrives over the realtime bus and applies at once", async () => {
    // The other replica wrote the row; only its message reaches this one.
    await setApproval({ '/fwd': ['authorization'] });
    expect(await seen('/fwd')).toEqual({ status: 200, body: NONE });
    await fromReplica();
    expect(await seen('/fwd')).toEqual({ status: 200, body: AUTH_ONLY });
    await sql`DELETE FROM zv_extension_forward_approvals WHERE name = ${NAME}`.execute(db);
    await fromReplica();
    expect(await seen('/fwd')).toEqual({ status: 200, body: NONE });
  });

  it('a withdrawal landing while the worker (re)starts still wins', async () => {
    await setApproval({ '/fwd': ['authorization'] });
    await reload();
    expect(await seen('/fwd')).toEqual({ status: 200, body: AUTH_ONLY });
    // The reload read the approval; before its worker is registered, the
    // approval is withdrawn on another replica and its message arrives here.
    const host = getWorkerHost(app);
    const start = host.start.bind(host);
    let applied: Promise<unknown> = Promise.resolve();
    host.start = async (...args: Parameters<typeof host.start>) => {
      host.start = start;
      await sql`DELETE FROM zv_extension_forward_approvals WHERE name = ${NAME}`.execute(db);
      applied = fromReplica() ?? Promise.resolve();
      await Bun.sleep(50);
      return start(...args);
    };
    try {
      await reload();
    } finally {
      host.start = start;
    }
    await applied;
    expect(await seen('/fwd')).toEqual({ status: 200, body: NONE });
  });

  it('two approval changes apply in the order their reads were made', async () => {
    await setApproval({ '/fwd': ['authorization'] });
    await fromReplica();
    expect(await seen('/fwd')).toEqual({ status: 200, body: AUTH_ONLY });
    // A refresh that read the approval, then is slow to hear back, and the
    // withdrawal's refresh after it: the older read must not land last.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowDb = new Proxy(db, {
      get(target, prop, recv) {
        if (prop !== 'selectFrom') return Reflect.get(target, prop, recv);
        return (...a: unknown[]) => {
          const q = (target.selectFrom as (...x: unknown[]) => unknown)(...a) as {
            select: (c: string) => { where: (...w: unknown[]) => { executeTakeFirst(): unknown } };
          };
          return {
            select: (c: string) => ({
              where: (...w: unknown[]) => ({
                async executeTakeFirst() {
                  const row = await q
                    .select(c)
                    .where(...w)
                    .executeTakeFirst();
                  await gate;
                  return row;
                },
              }),
            }),
          };
        };
      },
    }) as Database;
    const older = refreshForwardApproval(slowDb, [NAME]);
    await Bun.sleep(50);
    await sql`DELETE FROM zv_extension_forward_approvals WHERE name = ${NAME}`.execute(db);
    const newer = refreshForwardApproval(db, [NAME]);
    await Bun.sleep(50);
    release();
    await Promise.all([older, newer]);
    expect(await seen('/fwd')).toEqual({ status: 200, body: NONE });
  });

  it('an extension the registry has no row for can be approved', async () => {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await reload();
    expect((await approve({ '/fwd': ['authorization'] })).status).toBe(200);
    expect(await stored()).toEqual({ '/fwd': ['authorization'] });
    expect(await seen('/fwd')).toEqual({ status: 200, body: AUTH_ONLY });
  });
});
