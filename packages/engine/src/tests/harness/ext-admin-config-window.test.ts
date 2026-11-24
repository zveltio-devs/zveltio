// An extension request that mutates and is authorized against the `admin`
// object is configuration: without the session's step-up window it is refused
// exactly as an `/api/*` configuration mutation is (step_up_required), in both
// hosting modes, whatever the extension does with the refusal. A read checking
// `admin`, and a mutation checking a collection, are not configuration.
//
// Inline, the extension's own `checkPermission` decides; a worker is declared
// model only (RFC v3 phase D slice 4), so there the engine decides its declared
// actions: one gated on `admin` is configuration, one on a collection is not.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth, passkeyRelyingParty } from '../../lib/auth.js';
import { DDLManager } from '../../lib/data/index.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import {
  asDefaultTenant,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { newSoftPasskey, passkeyStepUp, registerSoftPasskey } from '../../testing/step-up.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const MODES = ['inline', 'process'] as const;
type Mode = (typeof MODES)[number];
const extName = (m: Mode) => `cfgwin${m[0]}${SFX}`;
const COLL = `cfgwin_${SFX}`;
const TABLE = `zvd_${COLL}`;

// A route on the global app (inline only): an extension request all the same.
const publicRoute = `ctx.registerPublicRoute({
      method: 'POST',
      path: '/cfgwin-pub-${SFX}',
      handler: async (c) => {
        const s = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
        return s && (await ctx.checkPermission(s.user.id, 'admin', '*'))
          ? c.json({ admin: true })
          : c.json({ error: 'no' }, 403);
      },
    });`;

/** A worker's actions: the engine checks `permission` before either runs. */
const workerEntry = (name: string) => `
const save = (title) => async (_input, host) => {
  await host.collections.insert('${COLL}', { title });
  return { saved: true };
};
export default {
  name: '${name}',
  actions: { settings: save('worker-settings'), item: save('worker-item') },
  async register() {},
};
`;

const workerManifest = {
  permissions: ['data:write'],
  resources: ['admin'],
  actions: [
    { name: 'settings', permission: { resource: 'admin', action: 'update' }, input: {}, writes: [COLL] },
    { name: 'item', permission: { resource: COLL, action: 'create' }, input: {}, writes: [COLL] },
  ],
};

const entry = (name: string) => `
export default {
  name: '${name}',
  mountStrategy: 'subapp',
  async register(app, ctx) {
    const may = (c, obj, act) => ctx.checkPermission(c.get('user').id, obj, act);
    const write = (title) => ctx.db.insertInto('${TABLE}').values({ title }).execute();
    const save = async (c, label) => {
      await write(label);
      return c.json({ saved: true });
    };
    app.get('/settings', async (c) => c.json({ admin: await may(c, 'admin', '*') }));
    // Writes before it checks, so a refusal must also undo the write.
    app.post('/settings', async (c) => {
      await write('early');
      return (await may(c, 'admin', '*')) ? save(c, 'settings') : c.json({ error: 'no' }, 403);
    });
    // Swallows whatever the check throws, as several extensions do — after a
    // write, so the refusal it swallowed must still undo that write.
    app.post('/swallow', async (c) => {
      await write('early-swallow');
      return (await may(c, 'admin', '*').catch(() => false)) ? save(c, 'swallow') : c.json({ error: 'Forbidden' }, 403);
    });
    app.post('/items', async (c) =>
      (await may(c, '${COLL}', 'create')) ? save(c, 'item') : c.json({ error: 'no' }, 403));
    ${publicRoute}
    app.post('/tenant-admin', async (c) =>
      ctx.internals && (await ctx.internals.isTenantAdmin(c.get('user').id))
        ? save(c, 'tenant-admin')
        : c.json({ error: 'no' }, 403));
  },
};
`;

function writeExt(base: string, name: string, worker: boolean) {
  const dir = join(base, name);
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      ...(worker ? workerManifest : {}),
      engine: {
        entry: 'engine/index.js',
        bundled: true,
        ...(worker ? { isolation: 'worker' } : {}),
      },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), worker ? workerEntry(name) : entry(name));
}

d('an extension mutation authorized against admin needs the configuration window', () => {
  let db: Database;
  let engine: Hono;
  let base = '';
  let cookie = '';
  let stepUp: () => Promise<unknown> = async () => undefined;
  const app = new Hono();
  const loadErrors: Record<string, string | undefined> = {};
  const saved = { transport: process.env.ZVELTIO_EXT_TRANSPORT, ctx: extensionLoader.ctx };

  const call = async (mode: Mode, method: string, path: string) => {
    const r = await app.request(`/ext/${extName(mode)}${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: r.status, body: text };
    }
  };
  const titles = async () =>
    (
      await asDefaultTenant(
        db,
        sql<{ title: string }>`SELECT title FROM ${sql.table(TABLE)} ORDER BY title`,
      )
    ).rows.map((r) => r.title);

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    // A god with a passkey and no step-up yet.
    cookie = await createGodSession(engine, db, { factor: false });
    const pk = await newSoftPasskey();
    const { origin } = passkeyRelyingParty();
    const req = (path: string, init?: RequestInit) => engine.request(path, init);
    expect(
      (await registerSoftPasskey(req, cookie, pk, origin, { password: 'HarnessGod123!' })).status,
    ).toBe(200);
    stepUp = () => passkeyStepUp(req, cookie, pk, 'config', origin);

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
    base = mkdtempSync(join(tmpdir(), 'cfg-win-'));
    for (const mode of MODES) {
      const name = extName(mode);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
      await sql`INSERT INTO zv_extension_registry
                  (name, display_name, tenant_id, is_installed, is_enabled)
                VALUES (${name}, ${name}, NULL, true, true)`.execute(db);
      writeExt(base, name, mode !== 'inline');
      if (mode !== 'inline') process.env.ZVELTIO_EXT_TRANSPORT = mode;
      await extensionLoader.loadExtension(name, app, ctx, base);
      loadErrors[name] = extensionLoader.getLastLoadError(name);
    }
  }, 180_000);

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    if (saved.transport === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved.transport;
    extensionLoader.ctx = saved.ctx;
    _setInlineForTests(false);
    _resetWorkerHostForTests();
    for (const m of MODES) {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${extName(m)}`.execute(db);
      await revokeExtensionDbRoles(db, extName(m), true).catch(() => undefined);
    }
    await dropTestCollection(db, COLL);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('loads in both modes', () => {
    for (const m of MODES) expect(loadErrors[extName(m)]).toBeUndefined();
  });

  it('inline: without the window, an admin mutation is refused as step_up_required', async () => {
    for (const path of ['/settings', '/swallow', '/tenant-admin']) {
      const res = await call('inline', 'POST', path);
      expect({ path, ...res }).toMatchObject({
        path,
        status: 403,
        body: { code: 'step_up_required', errors: { action: 'config' } },
      });
    }
    const res = await app.request(`/cfgwin-pub-${SFX}`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('step_up_required');
    // Nothing it wrote is kept, the write before the check included.
    expect(await titles()).toEqual([]);
  });

  it('process: without the window, an action gated on admin is refused as step_up_required', async () => {
    expect(await call('process', 'POST', '/actions/settings')).toMatchObject({
      status: 403,
      body: { code: 'step_up_required', errors: { action: 'config' } },
    });
    expect(await titles()).toEqual([]);
  });

  it('inline: a read checking admin, and a collection mutation, are not configuration', async () => {
    expect(await call('inline', 'GET', '/settings')).toEqual({ status: 200, body: { admin: true } });
    expect(await call('inline', 'POST', '/items')).toEqual({ status: 200, body: { saved: true } });
    await asDefaultTenant(db, sql`DELETE FROM ${sql.table(TABLE)}`);
  });

  it('process: an action gated on a collection is not configuration', async () => {
    expect(await call('process', 'POST', '/actions/item')).toEqual({
      status: 200,
      body: { result: { saved: true } },
    });
    expect(await titles()).toEqual(['worker-item']);
    await asDefaultTenant(db, sql`DELETE FROM ${sql.table(TABLE)}`);
  });

  it('with the window open, the admin mutations pass', async () => {
    await stepUp();
    expect(await call('inline', 'POST', '/settings')).toEqual({ status: 200, body: { saved: true } });
    expect(await call('inline', 'POST', '/swallow')).toEqual({ status: 200, body: { saved: true } });
    expect(await call('process', 'POST', '/actions/settings')).toEqual({
      status: 200,
      body: { result: { saved: true } },
    });
    expect(await call('inline', 'POST', '/tenant-admin')).toEqual({
      status: 200,
      body: { saved: true },
    });
    expect(
      (await app.request(`/cfgwin-pub-${SFX}`, { method: 'POST', headers: { cookie } })).status,
    ).toBe(200);
    expect(await titles()).toEqual([
      'early',
      'early-swallow',
      'settings',
      'swallow',
      'tenant-admin',
      'worker-settings',
    ]);
  });
});
