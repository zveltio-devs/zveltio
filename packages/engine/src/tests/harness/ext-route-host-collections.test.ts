/**
 * ADR 0025: a route reaches its collections through `ctx.host(c).collections`.
 *
 * As the caller by default — the signed-in user, or the tenant's `public` role
 * on a public route (ADR 0017/0020) — and, inside `ctx.internals.asSystem`, as
 * the extension's own key principal (ADR 0022) for the collections it names
 * only. The owner reveal of ADR 0024 is the same whoever the principal is:
 * secrets come back to the extension that owns the collection, to no other.
 * Inline and worker-isolated routes alike.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ExtensionContext as SdkContext, ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { DDLManager } from '../../lib/data/index.js';
import { getAuth } from '../../lib/auth.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { getEnforcer, invalidateAllPermissionCaches } from '../../lib/tenancy/index.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { clearLocalRateLimitCache } from '../../middleware/rate-limit.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  asEveryTenant,
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() && process.env.FIELD_ENCRYPTION_KEY ? describe : describe.skip;
const TENANT_A = '00000000-0000-0000-0000-000000000001';
const STAMP = String(Date.now()).slice(-7);
/** Owned by EXT: `tok` is its secret. */
const S = `rhc_s_${STAMP}`;
/** Owned by EXT too, never named in its `asSystem`. */
const T = `rhc_t_${STAMP}`;
/** Owned by the worker-isolated WEXT. */
const W = `rhc_w_${STAMP}`;
const RES = `rhc_res_${STAMP}`;
const EXT = `rhc-ext-${STAMP}`;
const OTHER = `rhc-other-${STAMP}`;
const NOSYS = `rhc-nosys-${STAMP}`;
const WEXT = `rhcw${STAMP}`;
const TOKEN = 'ldap-bind-password-7f3a';

type Rec = Record<string, unknown>;
type Answer = { status: number; body: Rec | null; error?: string };

const field = (name: string, type: string) => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
});

/** The call's answer, or the refusal it threw, as JSON the test reads. */
const answering = (read: () => Promise<unknown>) => async (c: Context) => {
  try {
    return c.json({ status: 200, body: await read() });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return c.json({ status: e.status ?? 418, body: null, error: e.message });
  }
};

/** The routes each inline extension mounts, over `coll` and `untouched`. */
const routes = (coll: string, untouched: string) => (r: Hono, ctx: SdkContext) => {
  const h = (c: Context) => ctx.host!(c).collections;
  const sys = ctx.internals!.asSystem;
  r.get('/pub/read/:id', (c) => answering(() => h(c).read(coll, c.req.param('id')))(c));
  r.get('/priv/read/:id', (c) => answering(() => h(c).read(coll, c.req.param('id')))(c));
  r.get('/pub/sys/:id', (c) =>
    answering(() => sys([coll], () => h(c).read(coll, c.req.param('id'))))(c),
  );
  r.get('/pub/sys-other/:id', (c) =>
    answering(() => sys([coll], () => h(c).read(untouched, c.req.param('id'))))(c),
  );
  r.get('/priv/sys/:id', (c) =>
    answering(() => sys([coll], () => h(c).read(coll, c.req.param('id'))))(c),
  );
  r.get('/priv/list', (c) => answering(() => h(c).list(coll, { limit: 100 }))(c));
  r.post('/priv/insert', (c) => answering(() => h(c).insert(coll, { label: 'as-caller' }))(c));
  r.post('/pub/insert', (c) => answering(() => h(c).insert(coll, { label: 'as-caller' }))(c));
  r.post('/priv/update/:id', (c) =>
    answering(() => h(c).update(coll, c.req.param('id'), { label: 'updated-as-caller' }))(c),
  );
  r.post('/priv/delete/:id', (c) =>
    answering(() =>
      h(c)
        .delete(coll, c.req.param('id'))
        .then(() => ({ deleted: true })),
    )(c),
  );
  r.post('/pub/sys-insert', (c) =>
    answering(() => sys([coll], () => h(c).insert(coll, { label: 'as-system', tok: 'new' })))(c),
  );
  r.post('/pub/sys-update/:id', (c) =>
    answering(() =>
      sys([coll], () => h(c).update(coll, c.req.param('id'), { label: 'updated-as-system' })),
    )(c),
  );
  r.post('/pub/sys-delete/:id', (c) =>
    answering(() =>
      sys([coll], () =>
        h(c)
          .delete(coll, c.req.param('id'))
          .then(() => ({ deleted: true })),
      ),
    )(c),
  );
  // A sibling started outside the window while it is open: the caller's.
  r.get('/pub/sibling/:id', (c) =>
    answering(async () => {
      const id = c.req.param('id');
      const status = (p: Promise<unknown>) =>
        p.then(
          () => 200,
          (e: { status?: number }) => e.status ?? 418,
        );
      const [inside, outside] = await Promise.all([
        status(sys([coll], () => Bun.sleep(80).then(() => h(c).read(coll, id)))),
        status(Bun.sleep(20).then(() => h(c).read(coll, id))),
      ]);
      return { inside, outside };
    })(c),
  );
  // Started inside the window, run after it closed: the caller's again.
  r.get('/pub/sys-late/:id', (c) =>
    answering(async () => {
      let later: Promise<unknown> = Promise.resolve();
      await sys([coll], async () => {
        later = Bun.sleep(50).then(() => h(c).read(coll, c.req.param('id')));
        later.catch(() => {});
      });
      return later;
    })(c),
  );
};

/** A worker-isolated extension reading `W` through the bridge. */
const workerEntry = `
export default {
  name: '${WEXT}',
  mountStrategy: 'subapp',
  async register(app, ctx) {
    const answer = async (c, read) => {
      try { return c.json({ status: 200, body: await read() }); }
      catch (e) { return c.json({ status: e.status ?? 418, body: null, error: String(e.message) }); }
    };
    app.get('/pub/read/:id', (c) => answer(c, () => ctx.host(c).collections.read('${W}', c.req.param('id'))));
    app.get('/priv/read/:id', (c) => answer(c, () => ctx.host(c).collections.read('${W}', c.req.param('id'))));
    // No asSystem out of process: ctx.internals is refused, so the read stays the caller's.
    app.get('/pub/sys/:id', (c) => answer(c, async () => {
      let refused = null;
      try { await ctx.internals.asSystem(['${W}'], async () => null); } catch (e) { refused = String(e.message); }
      const read = await ctx.host(c).collections.read('${W}', c.req.param('id')).then(() => 200, (e) => e.status ?? 418);
      return { refused, read };
    }));
    app.get('/priv/undeclared/:id', (c) => answer(c, () => ctx.host(c).collections.read('${S}', c.req.param('id'))));
  },
};
`;

d('a route reaches its collections through host.collections (ADR 0025)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let god = '';
  let granted = '';
  let ungranted = '';
  /** Granted every action on S. */
  let writer = '';
  let row = '';
  let other = '';
  let wrow = '';
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
  async function load(
    ext: ZveltioExtension,
    manifest: Rec,
    dir = `/tmp/${ext.name}`,
  ): Promise<void> {
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
  const inline = (name: string, coll: string, untouched: string): ZveltioExtension => ({
    name,
    category: 'custom',
    mountStrategy: 'subapp',
    actions: name === EXT ? undefined : { noop: async () => null },
    async register(r, ctx) {
      routes(coll, untouched)(r as Hono, ctx as SdkContext);
    },
  });
  /** The route's JSON answer for `cookie`, or for an anonymous visitor. */
  const get = async (
    ext: string,
    path: string,
    cookie?: string,
    method = 'GET',
  ): Promise<Answer> => {
    const res = await app.request(`/ext/${ext}${path}`, {
      method,
      headers: cookie ? { cookie } : {},
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Answer;
  };
  const create = async (coll: string, body: Rec) => {
    const res = await engine.request(`/api/data/${coll}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return String(((await res.json()) as { id: string }).id);
  };
  const grantPublic = async (on: boolean) => {
    const e = await getEnforcer();
    if (on) await e.addPolicy('public', TENANT_A, S, 'read');
    else await e.removePolicy('public', TENANT_A, S, 'read');
    await invalidateAllPermissionCaches();
  };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    god = await createGodSession(engine, db);
    const secretColl = [field('label', 'text'), field('tok', 'secret')];
    await DDLManager.createCollection(db, { name: S, fields: secretColl } as never, {
      extension: EXT,
      defaultGrants: false,
    });
    await DDLManager.createCollection(db, { name: T, fields: [field('label', 'text')] } as never, {
      extension: EXT,
      defaultGrants: false,
    });
    await DDLManager.createCollection(db, { name: W, fields: secretColl } as never, {
      extension: WEXT,
      defaultGrants: false,
    });
    granted = (
      await createMemberSession(engine, db, {
        grants: [
          { collection: S, actions: ['read'] },
          { collection: W, actions: ['read'] },
        ],
      })
    ).cookie;
    ungranted = (await createMemberSession(engine, db, {})).cookie;
    writer = (
      await createMemberSession(engine, db, {
        grants: [{ collection: S, actions: ['read', 'create', 'update', 'delete'] }],
      })
    ).cookie;
    row = await create(S, { label: 'settings', tok: TOKEN });
    other = await create(T, { label: 'untouched' });
    wrow = await create(W, { label: 'worker-settings', tok: TOKEN });

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    _resetWorkerHostForTests();
    getWorkerHost(app);

    const pub = { publicRoutes: ['/pub/*'] };
    // Reaches S and T as their owner, through its declared `collections`.
    await load(inline(EXT, S, T), {
      ...pub,
      permissions: ['data:system'],
      collections: [S, T],
    });
    // Declares S through an action's reads; owns nothing.
    const reader = {
      ...pub,
      resources: [RES],
      actions: [
        {
          name: 'noop',
          permission: { resource: RES },
          input: { type: 'object' },
          reads: [S],
          writes: [S],
        },
      ],
    };
    await load(inline(OTHER, S, S), { ...reader, permissions: ['data:system'] });
    await load(inline(NOSYS, S, S), { ...reader, permissions: ['data:write'] });

    base = mkdtempSync(join(tmpdir(), 'rhc-'));
    mkdirSync(join(base, WEXT, 'engine'), { recursive: true });
    writeFileSync(join(base, WEXT, 'engine', 'index.js'), workerEntry);
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    const wmod = (await import(join(base, WEXT, 'engine', 'index.js'))).default as ZveltioExtension;
    await load(
      wmod,
      {
        ...pub,
        collections: [W],
        engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
      },
      join(base, WEXT),
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (saved.transport === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved.transport;
    await getWorkerHost(app)
      .stop(WEXT)
      .catch(() => undefined);
    _resetWorkerHostForTests();
    if (base) rmSync(base, { recursive: true, force: true });
    if (!db) return;
    await grantPublic(false).catch(() => {});
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${OTHER}, ${NOSYS}, ${WEXT})`.execute(
      db,
    );
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_revisions WHERE collection IN (${S}, ${T}, ${W})`.execute(trx),
    );
    for (const c of [S, T, W]) await dropTestCollection(db, c).catch(() => {});
    await sql`DELETE FROM zv_rate_limit_configs WHERE key_prefix = 'anon-read'`
      .execute(db)
      .catch(() => {});
    clearLocalRateLimitCache('anon-read');
  });

  it('a public route reads as the public role: refused without a grant', async () => {
    expect((await get(EXT, `/pub/read/${row}`)).status).toBe(403);
    // A signed-in visitor of a public route is `public` too (ADR 0020).
    expect((await get(EXT, `/pub/read/${row}`, granted)).status).toBe(403);
    await grantPublic(true);
    try {
      const a = await get(EXT, `/pub/read/${row}`);
      expect([a.status, a.body?.label]).toEqual([200, 'settings']);
    } finally {
      await grantPublic(false);
    }
  });

  it('an authenticated route reads as the user: one without a grant is refused', async () => {
    expect((await get(EXT, `/priv/read/${row}`, ungranted)).status).toBe(403);
    const a = await get(EXT, `/priv/read/${row}`, granted);
    // The owner's reveal, for the user's read of the owner's collection.
    expect([a.status, a.body?.label, a.body?.tok]).toEqual([200, 'settings', TOKEN]);
  });

  it('inside asSystem, a public route reads its row and the plaintext secret', async () => {
    const a = await get(EXT, `/pub/sys/${row}`);
    expect([a.status, a.body?.label, a.body?.tok]).toEqual([200, 'settings', TOKEN]);
  });

  it('the asSystem call is audited when it settles', async () => {
    await get(EXT, `/pub/sys/${row}`);
    await _settleAuditWrites();
    const rows = await sql<{ outcome: string }>`
      SELECT metadata->>'outcome' AS outcome FROM zv_audit_log
       WHERE event_type = 'extension.as_system' AND resource_id = ${S}
         AND metadata->>'extension' = ${`ext:${EXT}`}`.execute(db);
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((r) => r.outcome === 'ok')).toBe(true);
  });

  it('a collection asSystem does not name stays the caller’s, and so does a late call', async () => {
    const a = await get(EXT, `/pub/sys-other/${other}`);
    expect(a.status).toBe(403);
    expect((await get(EXT, `/pub/sys-late/${row}`)).status).toBe(403);
  });

  it('another extension’s route gets no secret, as the user or as itself', async () => {
    for (const a of [
      await get(OTHER, `/priv/read/${row}`, granted),
      await get(OTHER, `/pub/sys/${row}`),
    ]) {
      expect([a.status, a.body?.label]).toEqual([200, 'settings']);
      expect(a.body && 'tok' in a.body).toBe(false);
    }
  });

  it('without data:system, asSystem is refused', async () => {
    const a = await get(NOSYS, `/pub/sys/${row}`);
    expect(a.status).toBe(418);
    expect(a.error).toContain('data:system');
  });

  it('an authenticated route inside asSystem reads as the extension, not the user', async () => {
    expect((await get(EXT, `/priv/read/${row}`, ungranted)).status).toBe(403);
    const a = await get(EXT, `/priv/sys/${row}`, ungranted);
    expect([a.status, a.body?.label, a.body?.tok]).toEqual([200, 'settings', TOKEN]);
  });

  it('list adds the secret for the owner only', async () => {
    const own = await get(EXT, '/priv/list', granted);
    const records = (own.body?.records ?? []) as Rec[];
    expect(records.find((r) => r.id === row)?.tok).toBe(TOKEN);
    const foreign = await get(OTHER, '/priv/list', granted);
    expect(foreign.status).toBe(200);
    expect(((foreign.body?.records ?? []) as Rec[]).some((r) => r.id === row)).toBe(true);
    expect(JSON.stringify(foreign.body)).not.toContain(TOKEN);
  });

  it('writes as the caller need the grant and data:write', async () => {
    // Granted read only: refused by the data API.
    expect((await get(NOSYS, '/priv/insert', granted, 'POST')).status).toBe(403);
    // The extension without data:write is refused whoever calls.
    const noCap = await get(EXT, '/priv/insert', writer, 'POST');
    expect(noCap.error).toContain('data:write');
    const ins = await get(NOSYS, '/priv/insert', writer, 'POST');
    expect([ins.status, ins.body?.label]).toEqual([200, 'as-caller']);
    const id = String(ins.body?.id);
    expect((await get(NOSYS, `/priv/update/${id}`, granted, 'POST')).status).toBe(403);
    const upd = await get(NOSYS, `/priv/update/${id}`, writer, 'POST');
    expect([upd.status, upd.body?.label]).toEqual([200, 'updated-as-caller']);
    expect((await get(NOSYS, `/priv/delete/${id}`, granted, 'POST')).status).toBe(403);
    expect((await get(NOSYS, `/priv/delete/${id}`, writer, 'POST')).status).toBe(200);
  });

  it('inside asSystem a public route inserts, updates and deletes as the extension', async () => {
    // As the caller (`public`), a public route writes nothing.
    expect((await get(NOSYS, '/pub/insert', undefined, 'POST')).status).not.toBe(200);
    const ins = await get(EXT, '/pub/sys-insert', undefined, 'POST');
    expect([ins.status, ins.body?.label]).toEqual([200, 'as-system']);
    const id = String(ins.body?.id);
    expect((await get(EXT, `/pub/sys/${id}`)).body?.tok).toBe('new');
    const upd = await get(EXT, `/pub/sys-update/${id}`, undefined, 'POST');
    expect([upd.status, upd.body?.label]).toEqual([200, 'updated-as-system']);
    expect((await get(EXT, `/pub/sys-delete/${id}`, undefined, 'POST')).status).toBe(200);
    expect((await get(EXT, `/pub/sys/${id}`)).body).toBeNull();
  });

  it('a sibling call started outside the open window stays the caller’s', async () => {
    const a = await get(EXT, `/pub/sibling/${row}`);
    expect(a.body).toEqual({ inside: 200, outside: 403 });
  });

  it('a worker-isolated route has no asSystem: the read stays the caller’s', async () => {
    const a = await get(WEXT, `/pub/sys/${wrow}`);
    expect(String(a.body?.refused)).toContain('not available to a worker-isolated extension');
    expect(a.body?.read).toBe(403);
  }, 30_000);

  it('a worker-isolated route reaches it too, as the caller', async () => {
    expect((await get(WEXT, `/priv/read/${wrow}`, ungranted)).status).toBe(403);
    expect((await get(WEXT, `/pub/read/${wrow}`)).status).toBe(403);
    const a = await get(WEXT, `/priv/read/${wrow}`, granted);
    expect([a.status, a.body?.label, a.body?.tok]).toEqual([200, 'worker-settings', TOKEN]);
    expect((await get(WEXT, `/priv/undeclared/${row}`, granted)).error).toContain(
      'does not list in reads',
    );
  }, 30_000);
});
