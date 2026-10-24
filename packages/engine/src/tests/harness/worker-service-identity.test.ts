// A worker-isolated service answers `checkPermission` as the user of the request
// it was called in (owner decision L4): the caller's identity, recorded by the
// engine, never named by the calling extension. Inline, the service runs in the
// caller's async context and sees that user; a worker service saw none and
// answered false for everyone. Covered: an inline caller, a worker caller, a
// worker calling an inline service that calls the worker service, each with a
// session and an API key, and a call made outside any request (no user). Asked
// for a user other than the request's — the god — the worker still says no.
// Its `ctx.auth.api.getSession()` answers that same caller as `{ user: { id } }`
// and nothing more (owner decision 2026-10-24): never the calling route's session.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const OWNER = `wsio${SFX}`;
const INLINE = `wsii${SFX}`;
const WORKER = `wsiw${SFX}`;
// A worker calling an inline service that calls the worker service.
const RELAY = `wsir${SFX}`;
const CHAIN = `wsic${SFX}`;
const ALL = [OWNER, INLINE, WORKER, RELAY, CHAIN];
const RES = `wsi_res_${SFX}`;

const ownerEntry = `
export default {
  name: '${OWNER}',
  async register(app, ctx) {
    ctx.services.register('${OWNER}.can', (uid, act) => ctx.checkPermission(uid, '${RES}', act));
    ctx.services.register('${OWNER}.session', () => ctx.auth.api.getSession({ headers: new Headers() }));
  },
};
`;

const relayEntry = `
export default {
  name: '${RELAY}',
  async register(app, ctx) {
    ctx.services.register('${RELAY}.can', (uid, act) => ctx.services.get('${OWNER}.can')(uid, act));
    ctx.services.register('${RELAY}.session', () => ctx.services.get('${OWNER}.session')());
  },
};
`;

const callerEntry = (name: string, svc = OWNER) => `
export default {
  name: '${name}',
  mountStrategy: 'subapp',
  async register(app, ctx) {
    const can = (uid, act) => ctx.services.get('${svc}.can')(uid, act);
    const session = async (c) => c.json({ s: await ctx.services.get('${svc}.session')() });
    app.get('/session', session);
    app.get('/pub', session);
    app.get('/perm', async (c) => c.json({
      read: await can(c.get('user').id, 'read'),
      del: await can(c.get('user').id, 'delete'),
    }));
    app.get('/as', async (c) => c.json({ other: await can(c.req.query('id'), 'read') }));
  },
};
`;

function writeExt(base: string, name: string, entry: string, worker: boolean, deps: string[]) {
  const dir = join(base, name);
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      dependencies: deps.map((n) => ({ name: n })),
      apiKeyRoutes: ['GET /perm', 'GET /session'],
      publicRoutes: ['/pub'],
      engine: {
        entry: 'engine/index.js',
        bundled: true,
        ...(worker ? { isolation: 'worker' } : {}),
      },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), entry);
}

d('a worker service answers checkPermission as the calling request', () => {
  let db: Database;
  let base = '';
  const app = new Hono();
  let godId = '';
  let memberId = '';
  let keyId = '';
  const asMember: Record<string, string> = {};
  const asKey: Record<string, string> = {};
  const saved = { transport: process.env.ZVELTIO_EXT_TRANSPORT, ctx: extensionLoader.ctx };

  beforeAll(async () => {
    const { app: engine, db: tdb } = await getTestApp();
    db = tdb;
    const godCookie = await createGodSession(engine, db);
    godId = (
      await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god' LIMIT 1`.execute(db)
    ).rows[0]!.id;
    const member = await createMemberSession(engine, db, {
      grants: [{ collection: RES, actions: ['read'] }],
    });
    memberId = member.userId;
    asMember.cookie = member.cookie;
    // The callee's check answers a key by the callee's scope, as inline: `$ext:<owner>`.
    const keyRes = await engine.request('/api/admin/api-keys', {
      method: 'POST',
      headers: { cookie: godCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `wsi-${SFX}`,
        scopes: ALL.map((n) => ({ collection: `$ext:${n}`, actions: ['read'] })),
      }),
    });
    const key = (await keyRes.json()) as { id: string; key: string };
    keyId = key.id;
    asKey['x-api-key'] = key.key;

    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    _resetWorkerHostForTests();
    getWorkerHost(app);
    _setInlineForTests(true);
    const ctx = {
      ...(extensionLoader.ctx ?? {}),
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as never;
    extensionLoader.ctx = ctx;
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';

    base = mkdtempSync(join(tmpdir(), 'wkr-svc-id-'));
    writeExt(base, OWNER, ownerEntry, true, []);
    writeExt(base, INLINE, callerEntry(INLINE), false, [OWNER]);
    writeExt(base, WORKER, callerEntry(WORKER), true, [OWNER]);
    writeExt(base, RELAY, relayEntry, false, [OWNER]);
    writeExt(base, CHAIN, callerEntry(CHAIN, RELAY), true, [RELAY]);
    for (const name of ALL) {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
      await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
                VALUES (${name}, ${name}, NULL, true, true)`.execute(db);
      await extensionLoader.loadExtension(name, app, ctx, base);
      expect(extensionLoader.getLastLoadError(name)).toBeUndefined();
    }
  }, 120_000);

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    if (saved.transport === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved.transport;
    extensionLoader.ctx = saved.ctx;
    _setInlineForTests(false);
    _resetWorkerHostForTests();
    for (const name of ALL) {
      extensionLoader.loaded.delete(name);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
      await revokeExtensionDbRoles(db, name, true).catch(() => undefined);
    }
    if (keyId) await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}`.execute(db);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  const get = async (ext: string, path: string, headers: Record<string, string>) => {
    const r = await app.request(`/ext/${ext}${path}`, { headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  for (const [caller, kind] of [
    [INLINE, 'inline'],
    [WORKER, 'worker'],
    [CHAIN, 'worker → inline'],
  ] as const) {
    it(`${kind} caller: the member's own grant answers true, a missing one false`, async () => {
      expect(await get(caller, '/perm', asMember)).toEqual({
        status: 200,
        body: { read: true, del: false },
      });
    });

    it(`${kind} caller with an API key: answered by the key's scope`, async () => {
      expect(await get(caller, '/perm', asKey)).toEqual({
        status: 200,
        body: { read: true, del: false },
      });
    });

    it(`${kind} caller: the service's getSession is the caller's user id, nothing more`, async () => {
      expect(await get(caller, '/session', asMember)).toEqual({
        status: 200,
        body: { s: { user: { id: memberId } } },
      });
    });

    it(`${kind} caller with an API key: getSession is the id checkPermission answers for`, async () => {
      expect(await get(caller, '/session', asKey)).toEqual({
        status: 200,
        body: { s: { user: { id: `apikey:${keyId}` } } },
      });
    });

    it(`${kind} caller: a user other than the request's is refused, even the god`, async () => {
      expect(await get(caller, `/as?id=${encodeURIComponent(godId)}`, asMember)).toEqual({
        status: 200,
        body: { other: false },
      });
    });
  }

  it('outside any request there is no user: false', async () => {
    const can = serviceRegistry.get<(u: string, a: string) => Promise<boolean>>(`${OWNER}.can`);
    expect(await can?.(memberId, 'read')).toBe(false);
  });

  for (const [caller, kind] of [
    [WORKER, 'worker'],
    [CHAIN, 'worker → inline'],
  ] as const) {
    it(`a public ${kind} route: the service sees the signed-in caller, or no one`, async () => {
      expect(await get(caller, '/pub', asMember)).toEqual({
        status: 200,
        body: { s: { user: { id: memberId } } },
      });
      expect(await get(caller, '/pub', {})).toEqual({ status: 200, body: { s: null } });
    });
  }

  it('outside any request the service has no session: null', async () => {
    const session = serviceRegistry.get<() => Promise<unknown>>(`${OWNER}.session`);
    expect(await session?.()).toBeNull();
  });
});
