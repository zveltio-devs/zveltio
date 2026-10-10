// What crosses from a request into a worker-isolated extension, on both
// transports (thread and runner process), behind the real `/ext/*` chain.
//
//   - The caller's credentials do not: the host proxy handed the worker every
//     header, so an untrusted extension read the caller's cookie, bearer token or
//     API key and could replay them as the caller. A public route gets back only
//     the ones its manifest names in `forwardCredentials`; signature headers
//     (`stripe-signature`, `x-hub-signature-256`) always pass.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { DDLManager } from '../../lib/data/index.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { applyTenantRLS, DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import {
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const MODES = ['inline', 'worker', 'process'] as const;
type Mode = (typeof MODES)[number];
const extName = (m: Mode) => `wkbnd${m[0]}${SFX}`;
const COLL = `wkbnd_${SFX}`;
const TABLE = `zvd_${COLL}`;
const HEADERS = [
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'stripe-signature',
  'x-hub-signature-256',
];

const entry = (name: string) => `
const seen = (c) => Object.fromEntries(${JSON.stringify(HEADERS)}.map((h) => [h, c.req.header(h) ?? null]));
export default {
  name: '${name}',
  mountStrategy: 'subapp',
  async register(app, ctx) {
    app.post('/hook', (c) => c.json(seen(c)));
    app.post('/fwd', (c) => c.json(seen(c)));
    app.get('/rows', async (c) =>
      c.json((await ctx.db.selectFrom('${TABLE}').select('title').execute()).length));
    app.post('/touch', async (c) => {
      const u = await ctx.db.updateTable('${TABLE}').set({ title: 'touched' }).executeTakeFirst();
      const d = await ctx.db.deleteFrom('${TABLE}').executeTakeFirst();
      return c.json({ updated: Number(u.numUpdatedRows), deleted: Number(d.numDeletedRows) });
    });
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
      publicRoutes: ['/hook', '/fwd'],
      forwardCredentials: { '/fwd': ['authorization'] },
      engine: {
        entry: 'engine/index.js',
        bundled: true,
        ...(worker ? { isolation: 'worker' } : {}),
      },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), entry(name));
}

d('a worker extension is not handed the caller credentials', () => {
  let db: Database;
  let base = '';
  const app = new Hono();
  const out = {} as Record<Mode, Record<string, unknown>>;
  const loadErrors: Record<string, string | undefined> = {};
  let memberId = '';
  const saved = {
    transport: process.env.ZVELTIO_EXT_TRANSPORT,
    inline: process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY,
    ctx: extensionLoader.ctx,
  };

  const call = async (
    mode: Mode,
    path: string,
    headers: Record<string, string>,
    method = 'GET',
  ) => {
    const r = await app.request(`/ext/${extName(mode)}${path}`, { method, headers });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: r.status, body: text };
    }
  };

  beforeAll(async () => {
    const { app: engine, db: tdb } = await getTestApp();
    db = tdb;
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await applyTenantRLS(db, TABLE);
    await sql`INSERT INTO ${sql.table(TABLE)} (title, tenant_id)
              VALUES ('a', ${DEFAULT_TENANT_ID}::uuid), ('b', ${DEFAULT_TENANT_ID}::uuid)`.execute(
      db,
    );
    const member = await createMemberSession(engine, db, {
      grants: [{ collection: COLL, actions: ['read', 'update', 'delete'] }],
    });
    memberId = member.userId;
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from)
              VALUES (${DEFAULT_TENANT_ID}::uuid, ${memberId}, 'member', now() - interval '2 days')
              ON CONFLICT (tenant_id, user_id) DO UPDATE SET valid_to = NULL`.execute(db);

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

    base = mkdtempSync(join(tmpdir(), 'wkr-bnd-'));
    for (const mode of MODES) {
      const name = extName(mode);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
      await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
                VALUES (${name}, ${name}, NULL, true, true)`.execute(db);
      writeExt(base, name, mode !== 'inline');
      if (mode !== 'inline') process.env.ZVELTIO_EXT_TRANSPORT = mode;
      await extensionLoader.loadExtension(name, app, ctx, base);
      loadErrors[name] = extensionLoader.getLastLoadError(name);
    }

    const creds = {
      cookie: member.cookie,
      authorization: 'Bearer caller-token',
      'proxy-authorization': 'Basic cHJveHk6cHc=',
      'x-api-key': 'caller-api-key',
      'stripe-signature': 't=1,v1=abc',
      'x-hub-signature-256': 'sha256=0123',
    };
    const asMember = { cookie: member.cookie };
    for (const mode of MODES) {
      out[mode] = {
        hook: await call(mode, '/hook', creds, 'POST'),
        fwd: await call(mode, '/fwd', creds, 'POST'),
        rowsInForce: await call(mode, '/rows', asMember),
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
      await sql`DELETE FROM zv_extension_registry WHERE name = ${extName(m)}`.execute(db);
      await revokeExtensionDbRoles(db, extName(m), true).catch(() => undefined);
    }
    await sql`DELETE FROM zv_tenant_users WHERE user_id = ${memberId}`.execute(db);
    await dropTestCollection(db, COLL);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('loads in all three modes', () => {
    for (const m of MODES) expect(loadErrors[extName(m)]).toBeUndefined();
  });

  it('inline is unchanged: the extension sees every header', () => {
    expect(out.inline.hook).toMatchObject({
      status: 200,
      body: { authorization: 'Bearer caller-token', 'x-api-key': 'caller-api-key' },
    });
  });

  for (const m of ['worker', 'process'] as const) {
    describe(m, () => {
      it('the caller credentials do not reach the worker; signatures do', () => {
        expect(out[m]?.hook).toEqual({
          status: 200,
          body: {
            cookie: null,
            authorization: null,
            'proxy-authorization': null,
            'x-api-key': null,
            'stripe-signature': 't=1,v1=abc',
            'x-hub-signature-256': 'sha256=0123',
          },
        });
      });

      it('a public route gets back exactly the credential its manifest names', () => {
        expect(out[m]?.fwd).toEqual({
          status: 200,
          body: {
            cookie: null,
            authorization: 'Bearer caller-token',
            'proxy-authorization': null,
            'x-api-key': null,
            'stripe-signature': 't=1,v1=abc',
            'x-hub-signature-256': 'sha256=0123',
          },
        });
      });

      it('an in-force member reads the tenant (the control)', () => {
        expect(out[m]?.rowsInForce).toEqual({ status: 200, body: 2 });
      });
    });
  }
});
