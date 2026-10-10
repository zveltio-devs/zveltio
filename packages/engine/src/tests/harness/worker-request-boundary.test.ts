// What crosses from a request into a worker-isolated extension, on the process
// transport (the runner protocol), behind the real `/ext/*` chain.
//
//   - The caller's credentials do not: the host proxy handed the worker every
//     header, so an untrusted extension read the caller's cookie, bearer token or
//     API key and could replay them as the caller. A public route gets back only
//     the ones its manifest names in `forwardCredentials`; signature headers
//     (`stripe-signature`, `x-hub-signature-256`) always pass.
//   - The caller's reach does, when it is narrower than the tenant: a member
//     whose default-tenant assignment lapsed reads nothing inline (NO_UNITS), and
//     read and wrote the whole tenant through a worker, which published only
//     `zveltio.current_tenant`.
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
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const MODES = ['inline', 'process'] as const;
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
    app.post('/add', async (c) => {
      try {
        await ctx.db.insertInto('${TABLE}').values({ title: 'added' }).execute();
        return c.json({ added: true });
      } catch {
        return c.json({ added: false });
      }
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

d('a worker extension is handed neither the caller credentials nor a wider reach', () => {
  let db: Database;
  let base = '';
  const app = new Hono();
  const out = {} as Record<Mode, Record<string, unknown>>;
  const loadErrors: Record<string, string | undefined> = {};
  let memberId = '';
  const saved = {
    transport: process.env.ZVELTIO_EXT_TRANSPORT,
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
      grants: [{ collection: COLL, actions: ['read', 'create', 'update', 'delete'] }],
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
    // After every mode has counted, so one mode's insert is not the next one's row.
    for (const mode of MODES) out[mode]!.addInForce = await call(mode, '/add', asMember, 'POST');
    // Every assignment of the member in the default tenant lapses.
    await sql`UPDATE zv_tenant_users SET valid_to = now() - interval '1 day'
              WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid AND user_id = ${memberId}`.execute(db);
    // Each mode on the same two rows, so one mode's leak cannot hide the next one's.
    for (const mode of MODES) {
      await sql`DELETE FROM ${sql.table(TABLE)}`.execute(db);
      await sql`INSERT INTO ${sql.table(TABLE)} (title, tenant_id)
                VALUES ('a', ${DEFAULT_TENANT_ID}::uuid), ('b', ${DEFAULT_TENANT_ID}::uuid)`.execute(
        db,
      );
      out[mode]!.rowsLapsed = await call(mode, '/rows', asMember);
      out[mode]!.touchLapsed = await call(mode, '/touch', asMember, 'POST');
      out[mode]!.addLapsed = await call(mode, '/add', asMember, 'POST');
      out[mode]!.added = (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(TABLE)}
                                 WHERE title = 'added'`.execute(db)
      ).rows[0]?.n;
      out[mode]!.left = (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(TABLE)}
                                 WHERE title IN ('a', 'b')`.execute(db)
      ).rows[0]?.n;
    }
  }, 180_000);

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    for (const [k, v] of [['ZVELTIO_EXT_TRANSPORT', saved.transport]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    extensionLoader.ctx = saved.ctx;
    _setInlineForTests(false);
    _resetWorkerHostForTests();
    for (const m of MODES) {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${extName(m)}`.execute(db);
      await revokeExtensionDbRoles(db, extName(m), true).catch(() => undefined);
    }
    await sql`DELETE FROM zv_tenant_users WHERE user_id = ${memberId}`.execute(db);
    await dropTestCollection(db, COLL);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('loads in both modes', () => {
    for (const m of MODES) expect(loadErrors[extName(m)]).toBeUndefined();
  });

  it('inline is unchanged: the extension sees every header', () => {
    expect(out.inline.hook).toMatchObject({
      status: 200,
      body: { authorization: 'Bearer caller-token', 'x-api-key': 'caller-api-key' },
    });
  });

  it('inline: a lapsed member reads and writes nothing (the reach worker mode must match)', () => {
    expect(out.inline.rowsInForce).toEqual({ status: 200, body: 2 });
    expect(out.inline.rowsLapsed).toEqual({ status: 200, body: 0 });
    expect(out.inline.touchLapsed).toEqual({ status: 200, body: { updated: 0, deleted: 0 } });
    expect(out.inline.left).toBe(2);
    // Migration 060: the write check uses the read reach, so an insert is refused too.
    expect(out.inline.addInForce).toEqual({ status: 200, body: { added: true } });
    expect(out.inline.addLapsed).toEqual({ status: 200, body: { added: false } });
    expect(out.inline.added).toBe(0);
  });

  for (const m of ['process'] as const) {
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

      it('a lapsed member reads nothing and its update and delete touch nothing', () => {
        expect(out[m]?.rowsLapsed).toEqual(out.inline.rowsLapsed);
        expect(out[m]?.touchLapsed).toEqual(out.inline.touchLapsed);
        expect(out[m]?.left).toBe(2);
      });

      it('a lapsed member inserts nothing (migration 060)', () => {
        expect(out[m]?.addInForce).toEqual({ status: 200, body: { added: true } });
        expect(out[m]?.addLapsed).toEqual({ status: 200, body: { added: false } });
        expect(out[m]?.added).toBe(0);
      });
    });
  }
});
