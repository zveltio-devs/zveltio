// A service a worker route calls runs in that request's transaction, inline or
// worker callee alike, and is ordered against the caller's `db.transaction()`.
//
// - An inline service ran in a transaction of its own and COMMITTED when it
//   returned: the calling worker route then threw, and the service's row stood.
//   It now runs in the request's tenant transaction, which a worker route that
//   threw rolls back with the worker's own.
// - A worker service an inline one called on the request's behalf ran its
//   statements each in a transaction of its own, committed at once.
// - Another worker's statements, reached through a service call, landed in
//   whatever savepoint the caller had open: a call made BESIDE a throwing scope
//   was undone with it, and a callee's own `db.transaction()` opened inside the
//   caller's savepoint made the caller's RELEASE fail. They now take turns with
//   the caller's scopes; a call made INSIDE a scope stays in it.
//
// Through the real tenant middleware and loader, over the process transport.
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
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const INLINE = `wstxi${SFX}`;
const CALLEE = `wstxb${SFX}`;
const CALLER = `wstxa${SFX}`;
const ALL = [CALLEE, INLINE, CALLER];
const table = (name: string) => `zv_${name}_rows`;

const inlineEntry = `
export default {
  name: '${INLINE}',
  async register(app, ctx) {
    ctx.services.register('${INLINE}.write', (who) =>
      ctx.db.insertInto('${table(INLINE)}').values({ who }).execute().then(() => true));
    ctx.services.register('${INLINE}.relay', (who) => ctx.services.get('${CALLEE}.write')(who));
  },
};
`;

const calleeEntry = `
const T = '${table(CALLEE)}';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default {
  name: '${CALLEE}',
  async register(app, ctx) {
    const add = (who) => ctx.db.insertInto(T).values({ who }).execute();
    ctx.services.register('${CALLEE}.write', async (who) => { await add(who); return true; });
    ctx.services.register('${CALLEE}.scoped', (who) =>
      ctx.db.transaction().execute(async () => {
        await add(who + '1');
        await sleep(100);
        await add(who + '2');
        return true;
      }));
    // Returns with its scope still open.
    ctx.services.register('${CALLEE}.leaky', async (who) => {
      let opened = () => {};
      const open = new Promise((r) => { opened = r; });
      ctx.db.transaction().execute(async () => {
        await add(who);
        opened();
        await sleep(300);
        await add(who + '-late');
      }).catch(() => undefined);
      await open;
      return true;
    });
  },
};
`;

const callerEntry = `
const T = '${table(CALLER)}';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default {
  name: '${CALLER}',
  async register(app, ctx) {
    const db = ctx.db;
    const add = (who) => db.insertInto(T).values({ who }).execute();
    const svc = (name, who) => ctx.services.get(name)(who);
    // The inline service writes, then the route throws.
    app.get('/inline-throw', async () => {
      await svc('${INLINE}.write', 'thrown');
      throw new Error('route fails after the inline service wrote');
    });
    app.get('/inline-ok', async (c) => c.json(await svc('${INLINE}.write', 'answered')));
    // Through an inline service to a worker one, then the route throws.
    app.get('/chain-throw', async () => {
      await svc('${INLINE}.relay', 'chained');
      throw new Error('route fails after the chain wrote');
    });
    // A plain callee write made beside a scope that throws.
    app.get('/beside-throw', async (c) => c.json((await Promise.allSettled([
      db.transaction().execute(async () => {
        await add('bt-a1');
        await sleep(80);
        await add('bt-a2');
        throw new Error('scope fails');
      }),
      (async () => { await sleep(20); return svc('${CALLEE}.write', 'bt-b'); })(),
    ])).map((r) => r.status)));
    // A callee's own scope opened beside the caller's: both end cleanly.
    app.get('/beside-scope', async (c) => c.json((await Promise.allSettled([
      db.transaction().execute(async () => {
        await add('bs-a1');
        await sleep(60);
        await add('bs-a2');
      }),
      (async () => { await sleep(20); return svc('${CALLEE}.scoped', 'bs-b'); })(),
    ])).map((r) => r.status)));
    // A callee leaves its scope open: undone, and the caller's turn still comes.
    app.get('/leaky', async (c) => {
      await svc('${CALLEE}.leaky', 'lk');
      await add('lk-a');
      return c.json(true);
    });
    // A call made INSIDE a scope that then throws is undone with it.
    app.get('/inside-throw', async (c) => c.json((await Promise.allSettled([
      db.transaction().execute(async () => {
        await svc('${CALLEE}.scoped', 'it-b');
        await add('it-a');
        throw new Error('scope fails');
      }),
    ])).map((r) => r.status)));
  },
};
`;

function writeExt(base: string, name: string, entry: string, worker: boolean, deps: string[]) {
  const dir = join(base, name);
  mkdirSync(join(dir, 'engine', 'migrations'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      dependencies: deps.map((n) => ({ name: n })),
      publicRoutes: ['/*'],
      engine: {
        entry: 'engine/index.js',
        bundled: true,
        ...(worker ? { isolation: 'worker' } : {}),
      },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), entry);
  writeFileSync(
    join(dir, 'engine', 'migrations', '001_rows.sql'),
    [
      `CREATE TABLE IF NOT EXISTS ${table(name)} (id serial PRIMARY KEY, who text);`,
      '-- DOWN',
      `DROP TABLE IF EXISTS ${table(name)};`,
    ].join('\n'),
  );
}

d('a service call in a worker request runs in the request transaction', () => {
  let db: Database;
  let base = '';
  const app = new Hono();
  const saved = { transport: process.env.ZVELTIO_EXT_TRANSPORT, ctx: extensionLoader.ctx };

  beforeAll(async () => {
    ({ db } = await getTestApp());
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

    // An inline extension's migrations are not this test's subject: its table, made here.
    await sql`CREATE TABLE IF NOT EXISTS ${sql.table(table(INLINE))} (id serial PRIMARY KEY, who text)`.execute(
      db,
    );
    base = mkdtempSync(join(tmpdir(), 'wkr-svc-txn-'));
    writeExt(base, INLINE, inlineEntry, false, [CALLEE]);
    writeExt(base, CALLEE, calleeEntry, true, []);
    writeExt(base, CALLER, callerEntry, true, [INLINE, CALLEE]);
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
      await sql`DROP TABLE IF EXISTS ${sql.table(table(name))}`.execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${name}:%`}`.execute(db);
    }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  const get = async (path: string) => {
    const r = await app.request(`/ext/${CALLER}${path}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const rows = async (name: string, prefix: string) =>
    (
      await sql<{ who: string }>`SELECT who FROM ${sql.table(table(name))}
                                 WHERE who LIKE ${`${prefix}%`} ORDER BY who`.execute(db)
    ).rows.map((r) => r.who);

  it('an inline service called by a worker route that then throws: its write is undone', async () => {
    expect((await get('/inline-throw')).status).toBe(500);
    expect(await rows(INLINE, 'thrown')).toEqual([]);
  });

  it('an inline service called by a worker route that answers: its write stands', async () => {
    expect(await get('/inline-ok')).toEqual({ status: 200, body: true });
    expect(await rows(INLINE, 'answered')).toEqual(['answered']);
  });

  it('a worker service reached through an inline one, then the route throws: undone', async () => {
    expect((await get('/chain-throw')).status).toBe(500);
    expect(await rows(CALLEE, 'chained')).toEqual([]);
  });

  it('a worker service called beside a throwing scope: its write is not undone with it', async () => {
    expect(await get('/beside-throw')).toEqual({ status: 200, body: ['rejected', 'fulfilled'] });
    expect(await rows(CALLER, 'bt-')).toEqual([]);
    expect(await rows(CALLEE, 'bt-')).toEqual(['bt-b']);
  });

  it("a worker service's own scope beside the caller's: both end, both stand", async () => {
    expect(await get('/beside-scope')).toEqual({ status: 200, body: ['fulfilled', 'fulfilled'] });
    expect(await rows(CALLER, 'bs-')).toEqual(['bs-a1', 'bs-a2']);
    expect(await rows(CALLEE, 'bs-')).toEqual(['bs-b1', 'bs-b2']);
  });

  it('a worker service that returns with its scope open: the scope is undone', async () => {
    expect(await get('/leaky')).toEqual({ status: 200, body: true });
    expect(await rows(CALLER, 'lk')).toEqual(['lk-a']);
    expect(await rows(CALLEE, 'lk')).toEqual([]);
  });

  it('a worker service called inside a scope that throws: undone with it', async () => {
    expect(await get('/inside-throw')).toEqual({ status: 200, body: ['rejected'] });
    expect(await rows(CALLER, 'it-')).toEqual([]);
    expect(await rows(CALLEE, 'it-')).toEqual([]);
  });
});
