// One `ctx` contract, inline and out of process (RFC extension-runner, step 7).
// The same extension source is loaded twice through the real loader, behind
// the real `/ext/*` chain (prefetch, tenant transaction, auth gate): inline and
// as a runner process (the in-thread worker is gone since step 9). Each
// capability must answer the same — Kysely on `ctx.db`, the request's `auth`
// (session and API key), `checkPermission`, `events`, `config`, `services.get`
// and an uncaught SQLSTATE.
// Before step 7 a worker got `{ query() }`, no auth, no checkPermission, no
// events, no config and a `services.get` that called instead of returning.
//
// Where they must differ is identity: a worker's `checkPermission` answers for
// the request's user only — never for a user id the extension names — and its
// events stay in its own namespace. What cannot cross fails the load by name.
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
import { engineEvents } from '../../lib/runtime/index.js';
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
const MODES = ['inline', 'process'] as const;
type Mode = (typeof MODES)[number];
const extName = (m: string) => `wkctx${m[0]}${SFX}`;
const table = (m: string) => `zv_${extName(m)}_items`;
const RES = `wkctx_res_${SFX}`;

const entry = (name: string, t: string) => `
let last = null;
export default {
  name: '${name}',
  mountStrategy: 'subapp',
  getMigrations: () => [new URL('./migrations/001_items.sql', import.meta.url).pathname],
  async register(app, ctx) {
    ctx.services.register('${name}.double', (n) => n * 2);
    ctx.events.on('${name}.ping', (p) => { last = p; });
    app.get('/who', async (c) => {
      const s = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
      return c.json({ user: c.get('user')?.id ?? null, session: s?.user?.id ?? null });
    });
    app.get('/perm', async (c) => c.json({
      read: await ctx.checkPermission(c.get('user').id, '${RES}', 'read'),
      del: await ctx.checkPermission(c.get('user').id, '${RES}', 'delete'),
    }));
    app.get('/as', async (c) =>
      c.json({ other: await ctx.checkPermission(c.req.query('id'), '${RES}', 'read') }));
    app.post('/kysely', async (c) => {
      await ctx.db.insertInto('${t}').values({ tag: 'k', tags: ['a', 'b'] }).execute();
      const rows = await ctx.db.selectFrom('${t}').select(['tag', 'tags']).where('tag', '=', 'k').execute();
      const u = await ctx.db.updateTable('${t}').set({ note: 'n' }).where('tag', '=', 'k').executeTakeFirst();
      const d = await ctx.db.deleteFrom('${t}').where('tag', '=', 'k').executeTakeFirst();
      return c.json({ rows, updated: Number(u.numUpdatedRows), deleted: Number(d.numDeletedRows) });
    });
    app.get('/bad-id', async (c) =>
      c.json(await ctx.db.selectFrom('${t}').selectAll().where('id', '=', 'not-a-number').execute()));
    app.get('/config', (c) => c.json({ vars: ctx.config.vars, env: ctx.config.env }));
    app.get('/svc', async (c) => {
      const fn = ctx.services.get('${name}.double');
      return c.json({ type: typeof fn, out: await fn(21) });
    });
    app.post('/event', async (c) => {
      last = null;
      await ctx.events.emitAsync('${name}.ping', { n: 7 });
      return c.json({ last });
    });
    app.post('/emit-engine', async (c) => {
      try { await ctx.events.emitAsync('record.deleted', { collection: 'x', id: '1', userId: 'u' }); return c.json({ emitted: true }); }
      catch { return c.json({ emitted: false }); }
    });
  },
};
`;

function writeExt(base: string, name: string, source: string, worker: boolean, migration = '') {
  const dir = join(base, name);
  mkdirSync(join(dir, 'engine', 'migrations'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      apiKeyRoutes: ['GET /who', 'GET /perm'],
      engine: {
        entry: 'engine/index.js',
        bundled: true,
        ...(worker ? { isolation: 'worker' } : {}),
      },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), source);
  if (migration) writeFileSync(join(dir, 'engine', 'migrations', '001_items.sql'), migration);
}

d('a worker extension gets the inline ctx contract', () => {
  let db: Database;
  let base = '';
  const app = new Hono();
  const out = {} as Record<Mode, Record<string, unknown>>;
  const loadErrors: Record<string, string | undefined> = {};
  let godId = '';
  const keyIds: string[] = [];
  const saved = {
    transport: process.env.ZVELTIO_EXT_TRANSPORT,
    inline: process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY,
    ctx: extensionLoader.ctx,
  };

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
    const keyRes = await engine.request('/api/admin/api-keys', {
      method: 'POST',
      headers: { cookie: godCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `wkctx-${SFX}`,
        scopes: MODES.map((m) => ({ collection: `$ext:${extName(m)}`, actions: ['read'] })),
      }),
    });
    const key = (await keyRes.json()) as { id: string; key: string };
    keyIds.push(key.id);

    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    _resetWorkerHostForTests();
    getWorkerHost(app);
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const ctx = {
      ...(extensionLoader.ctx ?? {}),
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as never;
    extensionLoader.ctx = ctx;

    base = mkdtempSync(join(tmpdir(), 'wkr-ctx-'));
    const asMember = { cookie: member.cookie };
    const asKey = { 'x-api-key': key.key };
    for (const mode of MODES) {
      const name = extName(mode);
      process.env[`ZVELTIO_EXT_${name.toUpperCase()}_GREETING`] = 'hi';
      // Enabled, as an installed extension is: the activation gate answers 404 otherwise.
      await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
      await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
                VALUES (${name}, ${name}, NULL, true, true)`.execute(db);
      writeExt(
        base,
        name,
        entry(name, table(mode)),
        mode !== 'inline',
        `CREATE TABLE IF NOT EXISTS ${table(mode)} ` +
          '(id serial PRIMARY KEY, tag text UNIQUE, note text, tags text[]);\n' +
          `-- DOWN\nDROP TABLE IF EXISTS ${table(mode)};\n`,
      );
      if (mode !== 'inline') process.env.ZVELTIO_EXT_TRANSPORT = mode;
      await extensionLoader.loadExtension(name, app, ctx, base);
      loadErrors[name] = extensionLoader.getLastLoadError(name);

      if (mode === 'inline') continue;
      // What cannot cross is refused while loading, by name.
      for (const [suffix, body] of [
        ['int', 'ctx.internals;'],
        ['rec', "ctx.events.on('record.created', () => {});"],
      ] as const) {
        const bad = `${name}${suffix}`;
        writeExt(
          base,
          bad,
          `export default { name: '${bad}', async register(app, ctx) { ${body} } };`,
          true,
        );
        await extensionLoader.loadExtension(bad, app, ctx, base);
        loadErrors[bad] = extensionLoader.getLastLoadError(bad);
      }
    }
    // Requested only once all are mounted: the first request builds the matcher.
    for (const mode of MODES) {
      const name = extName(mode);
      const get = async (path: string, headers: Record<string, string>, method = 'GET') => {
        const r = await app.request(`/ext/${name}${path}`, { method, headers });
        const text = await r.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* a plain-text failure */
        }
        return { status: r.status, body };
      };
      out[mode] = {
        whoSession: await get('/who', asMember),
        whoKey: await get('/who', asKey),
        permSession: await get('/perm', asMember),
        permKey: await get('/perm', asKey),
        asGod: await get(`/as?id=${encodeURIComponent(godId)}`, asMember),
        kysely: await get('/kysely', asMember, 'POST'),
        badId: (await get('/bad-id', asMember)).status,
        config: await get('/config', asMember),
        svc: await get('/svc', asMember),
        event: await get('/event', asMember, 'POST'),
        ...(mode === 'inline' ? {} : { emitEngine: await get('/emit-engine', asMember, 'POST') }),
      };
    }
  }, 180_000);

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    for (const [k, v] of [
      ['ZVELTIO_EXT_TRANSPORT', saved.transport],
      ['ZVELTIO_ALLOW_INLINE_THIRD_PARTY', saved.inline],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    extensionLoader.ctx = saved.ctx;
    _resetWorkerHostForTests();
    for (const m of MODES) {
      delete process.env[`ZVELTIO_EXT_${extName(m).toUpperCase()}_GREETING`];
      await sql`DROP TABLE IF EXISTS ${sql.table(table(m))}`.execute(db);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${extName(m)}`.execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${extName(m)}%`}`.execute(db);
      for (const n of [extName(m), `${extName(m)}int`, `${extName(m)}rec`]) {
        await revokeExtensionDbRoles(db, n, true).catch(() => undefined);
      }
    }
    for (const id of keyIds) await sql`DELETE FROM zv_api_keys WHERE id = ${id}`.execute(db);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('loads the same extension in both modes', () => {
    for (const m of MODES) expect(loadErrors[extName(m)]).toBeUndefined();
  });

  it('inline answers what the contract says', () => {
    expect(out.inline).toMatchObject({
      whoKey: { status: 200, body: { user: expect.stringMatching(/^apikey:/), session: null } },
      permSession: { status: 200, body: { read: true, del: false } },
      permKey: { status: 200, body: { read: true, del: false } },
      kysely: {
        status: 200,
        body: { rows: [{ tag: 'k', tags: ['a', 'b'] }], updated: 1, deleted: 1 },
      },
      badId: 400,
      config: { status: 200, body: { vars: { GREETING: 'hi' }, env: 'test' } },
      svc: { status: 200, body: { type: 'function', out: 42 } },
      event: { status: 200, body: { last: { n: 7 } } },
    });
  });

  for (const m of ['process'] as const) {
    describe(m, () => {
      const same = [
        'whoSession',
        'whoKey',
        'permSession',
        'permKey',
        'kysely',
        'badId',
        'config',
        'svc',
        'event',
      ];
      for (const k of same) {
        it(`${k} answers as inline`, () => {
          expect(out[m]?.[k]).toEqual(out.inline?.[k]);
        });
      }

      it('checkPermission answers for the request user only, never a user the worker names', () => {
        // Inline the extension is trusted with any id: asked for the god it says yes.
        expect(out.inline?.asGod).toEqual({ status: 200, body: { other: true } });
        expect(out[m]?.asGod).toEqual({ status: 200, body: { other: false } });
      });

      it('may not emit an engine event', () => {
        expect(out[m]?.emitEngine).toEqual({ status: 200, body: { emitted: false } });
      });

      it('refuses at load what cannot cross: ctx.internals', () => {
        expect(loadErrors[`${extName(m)}int`]).toContain(
          'ctx.internals is not available to a worker-isolated extension',
        );
      });

      it('refuses at load a listener on an engine event', () => {
        expect(loadErrors[`${extName(m)}rec`]).toContain('may not listen to "record.created"');
      });
    });
  }
});
