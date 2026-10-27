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
// - A worker service an INLINE route called ran its statements each in a
//   transaction of its own: the route then threw, and the service's row stood.
//   It now joins the route's tenant transaction, under its own role.
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
import { serviceRegistry } from '../../lib/service-registry.js';
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
const OUTER = `wstxo${SFX}`;
const ALL = [CALLEE, INLINE, CALLER, OUTER];
const table = (name: string) => `zv_${name}_rows`;

const inlineEntry = `
export default {
  name: '${INLINE}',
  mountStrategy: 'subapp',
  async register(app, ctx) {
    ctx.services.register('${INLINE}.write', (who) =>
      ctx.db.insertInto('${table(INLINE)}').values({ who }).execute().then(() => true));
    ctx.services.register('${INLINE}.relay', (who) => ctx.services.get('${CALLEE}.write')(who));
    const svc = (name, who) => ctx.services.get(name)(who);
    const xid = () => ctx.db
      .selectNoFrom((eb) => eb.cast(eb.fn('pg_current_xact_id'), 'text').as('x'))
      .executeTakeFirstOrThrow().then((r) => r.x);
    // Two first calls at once, each with its own scope: one joined transaction.
    app.get('/svc-pair-throw', async () => {
      await Promise.all([svc('${CALLEE}.scoped', 'ir-pair-a'), svc('${CALLEE}.scoped', 'ir-pair-b')]);
      throw new Error('route fails after both calls wrote');
    });
    app.get('/svc-pair-ok', async (c) => {
      await Promise.all([svc('${CALLEE}.scoped', 'ir-pair-c'), svc('${CALLEE}.scoped', 'ir-pair-d')]);
      return c.json({ ok: true });
    });
    // A timer the request leaves behind calls a worker service after it ended.
    app.get('/svc-late', (c) => {
      setTimeout(() => {
        svc('${CALLEE}.write', 'ir-late').then(
          () => { globalThis.__lateCall = 'ran'; },
          () => { globalThis.__lateCall = 'refused'; },
        );
      }, 50);
      return c.json(true);
    });
    app.get('/svc-late-result', (c) => c.json(globalThis.__lateCall ?? null));
    // An inline route calls a worker service, then throws.
    app.get('/svc-throw', async () => {
      await svc('${CALLEE}.write', 'ir-thrown');
      throw new Error('route fails after the worker service wrote');
    });
    // The route's settings, which the worker's statements set their own over.
    const settings = () => ctx.db
      .selectNoFrom((eb) => ['statement_timeout', 'zveltio.actor', 'zveltio.visible_tenants']
        .map((n, i) => eb.fn('current_setting', [eb.val(n)]).as('s' + i)))
      .executeTakeFirstOrThrow().then((r) => JSON.stringify(r));
    // A joined worker service cannot leave a setting changed for the route.
    app.get('/svc-tamper', async (c) => {
      const before = await settings();
      const sp = async () => (await ctx.db.selectNoFrom((eb) =>
        eb.fn('current_setting', [eb.val('search_path')]).as('p')).executeTakeFirstOrThrow()).p;
      const path = await sp();
      const tried = await svc('${CALLEE}.tamper');
      return c.json({ tried, same: before === (await settings()) && path === (await sp()) });
    });
    // ... or answers: one transaction, the route's, and the row is there for it.
    app.get('/svc-ok', async (c) => {
      const before = await settings();
      const theirs = await svc('${CALLEE}.xid');
      await svc('${CALLEE}.write', 'ir-ok');
      return c.json({
        same: theirs === (await xid()),
        seen: await svc('${CALLEE}.count', 'ir-ok'),
        restored: before === (await settings()),
      });
    });
    // The worker service's own db.transaction(), then the route throws.
    app.get('/svc-scoped-throw', async () => {
      await svc('${CALLEE}.scoped', 'is');
      throw new Error('route fails after the scoped service wrote');
    });
    // It returns with its scope open: undone, and the route goes on.
    app.get('/svc-leaky', async (c) => {
      await svc('${CALLEE}.leaky', 'il');
      await ctx.db.insertInto('${table(INLINE)}').values({ who: 'il-a' }).execute();
      return c.json(true);
    });
    // Not awaited: the request ends while the service still works.
    app.get('/svc-unawaited', async (c) => {
      svc('${CALLEE}.slow', 'iu').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
      return c.json(true);
    });
    // The route's own statements beside the call: each runs as its own extension.
    app.get('/svc-beside', async (c) => {
      await Promise.all([
        svc('${CALLEE}.write', 'ib-w'),
        ...[1, 2, 3].map((i) => ctx.db.insertInto('${table(INLINE)}').values({ who: 'ib-' + i }).execute()),
      ]);
      return c.json(true);
    });
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
    // Tries to change a setting of the request it joined; answers what it got.
    ctx.services.register('${CALLEE}.tamper', async () => {
      const tries = [
        "SELECT set_config('search_path', 'pg_temp', true)",
        'SET LOCAL search_path TO pg_temp',
        "SELECT set_config('zveltio.actor', 'someone-else', true)",
      ];
      const out = [];
      for (const q of tries) out.push(await ctx.db.query(q).then(() => 'ran', () => 'refused'));
      return out;
    });
    ctx.services.register('${CALLEE}.slow', async (who) => {
      await add(who + '1');
      await sleep(250);
      await add(who + '2');
      return true;
    });
    ctx.services.register('${CALLEE}.xid', () => ctx.db
      .selectNoFrom((eb) => eb.cast(eb.fn('pg_current_xact_id'), 'text').as('x'))
      .executeTakeFirstOrThrow().then((r) => r.x));
    ctx.services.register('${CALLEE}.count', (who) => ctx.db.selectFrom(T)
      .select((eb) => eb.fn.countAll().as('n')).where('who', '=', who)
      .executeTakeFirstOrThrow().then((r) => Number(r.n)));
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
    // An inline service called inside this worker's own scope runs in it.
    ctx.services.register('${CALLER}.nested', (who) =>
      db.transaction().execute(async () => {
        await add(who + '-a');
        await svc('${INLINE}.write', who + '-i');
        return true;
      }));
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

const outerEntry = `
export default {
  name: '${OUTER}',
  mountStrategy: 'subapp',
  async register(app, ctx) {
    app.get('/nested', async (c) => c.json(await ctx.services.get('${CALLER}.nested')('on')));
    app.get('/nested-throw', async () => {
      await ctx.services.get('${CALLER}.nested')('ont');
      throw new Error('route fails after the nested call wrote');
    });
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
    writeExt(base, OUTER, outerEntry, false, [CALLER]);
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

  const getInline = async (path: string) => {
    const r = await app.request(`/ext/${INLINE}${path}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  it('a worker service called by an inline route that then throws: its write is undone', async () => {
    expect((await getInline('/svc-throw')).status).toBe(500);
    expect(await rows(CALLEE, 'ir-thrown')).toEqual([]);
  });

  it('two first calls at once from an inline route: one transaction, undone or kept together', async () => {
    expect((await getInline('/svc-pair-throw')).status).toBe(500);
    expect(await rows(CALLEE, 'ir-pair-a')).toEqual([]);
    expect(await rows(CALLEE, 'ir-pair-b')).toEqual([]);
    expect((await getInline('/svc-pair-ok')).status).toBe(200);
    expect(await rows(CALLEE, 'ir-pair-c')).toEqual(['ir-pair-c1', 'ir-pair-c2']);
    expect(await rows(CALLEE, 'ir-pair-d')).toEqual(['ir-pair-d1', 'ir-pair-d2']);
  });

  it('a worker service called by a timer after its inline request ended: refused, nothing lands', async () => {
    expect((await getInline('/svc-late')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    expect((await getInline('/svc-late-result')).body).toBe('refused');
    expect(await rows(CALLEE, 'ir-late')).toEqual([]);
  });

  // The settings window restores a fixed list; this holds only while the worker
  // SQL policy refuses every way of setting one. If the policy ever admits one,
  // this fails.
  it("a joined worker service cannot change the route's settings", async () => {
    expect(await getInline('/svc-tamper')).toEqual({
      status: 200,
      body: { tried: ['refused', 'refused', 'refused'], same: true },
    });
  });

  it("a worker service called by an inline route that answers: in the route's transaction", async () => {
    expect(await getInline('/svc-ok')).toEqual({
      status: 200,
      body: { same: true, seen: 1, restored: true },
    });
    expect(await rows(CALLEE, 'ir-ok')).toEqual(['ir-ok']);
  });

  it("an inline route's statements beside the call: each extension under its own role", async () => {
    expect(await getInline('/svc-beside')).toEqual({ status: 200, body: true });
    expect(await rows(CALLEE, 'ib-')).toEqual(['ib-w']);
    expect(await rows(INLINE, 'ib-')).toEqual(['ib-1', 'ib-2', 'ib-3']);
  });

  it('a worker service whose own scope wrote, then the inline route throws: undone', async () => {
    expect((await getInline('/svc-scoped-throw')).status).toBe(500);
    expect(await rows(CALLEE, 'is')).toEqual([]);
  });

  it('a worker service that leaves its scope open in an inline request: the scope is undone', async () => {
    expect(await getInline('/svc-leaky')).toEqual({ status: 200, body: true });
    expect(await rows(CALLEE, 'il')).toEqual([]);
    expect(await rows(INLINE, 'il-')).toEqual(['il-a']);
  });

  it("an inline service called inside a joined worker service's scope runs in it", async () => {
    const outer = async (path: string) => (await app.request(`/ext/${OUTER}${path}`)).status;
    expect(await outer('/nested')).toBe(200);
    expect(await rows(CALLER, 'on-')).toEqual(['on-a']);
    expect(await rows(INLINE, 'on-')).toEqual(['on-i']);
    expect(await outer('/nested-throw')).toBe(500);
    expect(await rows(CALLER, 'ont')).toEqual([]);
    expect(await rows(INLINE, 'ont')).toEqual([]);
  });

  it('a joined worker service still running when its request ends: nothing lands after', async () => {
    expect(await getInline('/svc-unawaited')).toEqual({ status: 200, body: true });
    await new Promise((r) => setTimeout(r, 500));
    // Its first write went with the request; the one after the end was refused,
    // never sent to a connection the request no longer holds.
    expect(await rows(CALLEE, 'iu')).not.toContain('iu2');
  });

  it('a worker service called outside a request: each statement commits on its own', async () => {
    const write = serviceRegistry.get<(who: string) => Promise<unknown>>(`${CALLEE}.write`);
    expect(await write?.('outside')).toBe(true);
    expect(await rows(CALLEE, 'outside')).toEqual(['outside']);
  });

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
