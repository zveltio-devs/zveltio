// `db.transaction()` outside a request (RFC extension-runner, step 8, owner
// decision 4): in a schedule, an event handler, `register()`, the host opens a
// transaction of its own for the extension, routes the callback's statements
// into it, commits when the callback resolves and rolls back when it throws,
// times out (the request transaction's 30 s, shortened here through the same
// test setter), or the worker dies. It used to be refused by name.
// Driven through the real loader over the process transport.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getActiveBunPool } from '../../db/bun-sql-dialect.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';
import {
  _internalForTests,
  _resetWorkerHostForTests,
  getWorkerHost,
} from '../../lib/worker-extension-host.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const NAME = `wkrhtx${SFX}`;
const TENANT = crypto.randomUUID();
const tbl = (s: string) => `zv_${NAME}_${s}`;

const ENTRY = `
const T = (s) => 'zv_${NAME}_' + s;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WHO = "SELECT pg_backend_pid() AS pid, current_setting('role') AS role, " +
  "current_setting('zveltio.current_tenant', true) AS t";
export default {
  name: '${NAME}',
  async register(app, ctx) {
    const db = ctx.db;
    // The marker inline, not a parameter: pg_stat_activity shows the statement text.
    const add = (who) => db.query('INSERT INTO ' + T('rows') + " (who) VALUES ('" + who + "')");
    const log = (tag, body) =>
      db.query('INSERT INTO ' + T('log') + ' (tag, body) VALUES ($1, $2)', tag, JSON.stringify(body));
    const run = async (tag, fn) => {
      try { await log(tag, { ok: await db.transaction().execute(fn) }); }
      catch (e) { await log(tag, { err: e.message }); }
    };
    // A schedule: no request, no event — work register() left running.
    setTimeout(async () => {
      await run('sched', async (trx) => {
        await trx.insertInto(T('rows')).values({ who: 'sched-1' }).execute();
        await add('sched-2');
        return (await db.query(WHO))[0];
      });
      await run('sched-throw', async () => { await add('sched-thrown'); throw new Error('no'); });
    }, 0);
    ctx.events.on('${NAME}.run', async ({ op }) => {
      if (op === 'commit') {
        await run(op, async () => {
          const [a] = await db.query(WHO);
          await add('commit-1');
          // Nested: a savepoint, as in a request. Rolled back, the outer work stays.
          try {
            await db.transaction().execute(async () => { await add('commit-inner'); throw new Error('inner'); });
          } catch {}
          await add('commit-2');
          const [b] = await db.query(WHO);
          return { a, b };
        });
        // The same handler's plain statement: the scope the transaction ran as.
        await log('plain', (await db.query(WHO))[0]);
      }
      if (op === 'throw') await run(op, async () => { await add('thrown'); throw new Error('boom'); });
      if (op === 'slow') {
        await run(op, async () => { await add('slow-marker'); await sleep(1500); await add('slow-late'); });
      }
      if (op === 'pair') {
        // Two overlapping transactions: A must not see B's uncommitted row.
        const one = (who, wait, peek) => db.transaction().execute(async () => {
          const [w] = await db.query(WHO);
          await add(who);
          await sleep(wait);
          const [{ n }] = await db.query('SELECT count(*)::int AS n FROM ' + T('rows') + ' WHERE who = $1', peek);
          return { pid: w.pid, sawOther: n };
        });
        const [a, b] = await Promise.all([one('pair-a', 300, 'pair-b'), one('pair-b', 600, 'pair-a')]);
        await log(op, { a, b });
      }
      if (op === 'kill') {
        await db.transaction().execute(async () => {
          await add('kill-marker');
          await sleep(500);
          const p = (await import('node:process')).default;
          p.kill(p.pid, 'SIGKILL');
          await sleep(10_000);
        });
      }
    });
  },
};
`;

const MIGRATION = [
  `CREATE TABLE IF NOT EXISTS ${tbl('rows')} (id serial PRIMARY KEY, who text);`,
  `CREATE TABLE IF NOT EXISTS ${tbl('log')} (id serial PRIMARY KEY, tag text, body text);`,
  '-- DOWN',
  `DROP TABLE IF EXISTS ${tbl('log')};`,
  `DROP TABLE IF EXISTS ${tbl('rows')};`,
].join('\n');

type Who = { pid: number; role: string; t: string | null };

d('db.transaction() outside a request: a host-owned transaction', () => {
  let db: Database;
  let base = '';
  let login = '';
  let heldMidSlow = -1;
  let killMs = 0;
  let heldBeforeKill = -1;
  let schedRows: string[] = [];
  let pooled: { u: string; r: string; t: string | null }[] = [];
  const saved = process.env.ZVELTIO_EXT_TRANSPORT;
  const savedCtx = extensionLoader.ctx;

  const rows = async (where: string) =>
    (
      await sql<{
        who: string;
      }>`SELECT who FROM ${sql.table(tbl('rows'))} WHERE ${sql.raw(where)} ORDER BY id`.execute(db)
    ).rows.map((r) => r.who);
  const logged = async (tag: string) => {
    const r = (
      await sql<{
        body: string;
      }>`SELECT body FROM ${sql.table(tbl('log'))} WHERE tag = ${tag} ORDER BY id DESC LIMIT 1`.execute(
        db,
      )
    ).rows[0];
    return r ? JSON.parse(r.body) : undefined;
  };
  const held = async (marker: string) =>
    Number(
      (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state LIKE 'idle in transaction%'
            AND query LIKE ${`%${marker}%`}`.execute(db)
      ).rows[0]?.n,
    );
  const until = async (ok: () => Promise<boolean>, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!(await ok()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };
  const emit = (op: string) => engineEvents.emitAsync(`${NAME}.run` as never, { op } as never);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${TENANT}::uuid, ${`wkrhtx-${SFX}`}, 'htx', 'active')`.execute(db);
    // Enabled, as an installed extension is: event deliveries are gated on it.
    await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
              VALUES (${NAME}, ${NAME}, NULL, true, true)`.execute(db);
    base = mkdtempSync(join(tmpdir(), 'wkr-htx-'));
    const dir = join(base, NAME);
    mkdirSync(join(dir, 'engine', 'migrations'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: NAME,
        version: '1.0.0',
        engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
      }),
    );
    writeFileSync(join(dir, 'engine', 'index.js'), ENTRY);
    writeFileSync(join(dir, 'engine', 'migrations', '001_htx.sql'), MIGRATION);

    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    _resetWorkerHostForTests();
    const app = new Hono();
    getWorkerHost(app);
    const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
    extensionLoader.ctx = ctx;
    await extensionLoader.loadExtension(NAME, app, ctx, base);
    expect(extensionLoader.getLastLoadError(NAME)).toBeUndefined();
    try {
      const pool = getActiveBunPool();
      login = (await pool?.unsafe<{ u: string }>('SELECT session_user AS u'))?.[0]?.u ?? '';
      await until(async () => (await logged('sched-throw')) !== undefined);
      // Before the kill below: the respawned worker's register() schedules again.
      schedRows = await rows("who LIKE 'sched-%'");
      // An event emitted for a tenant, with no request and no caller.
      await runWithDomain(TENANT, () => emit('commit'));
      await emit('throw');
      await emit('pair');

      _internalForTests.setRequestTxnTimeoutMs(400);
      const slow = emit('slow');
      await new Promise((r) => setTimeout(r, 1000));
      heldMidSlow = await held('slow-marker');
      await slow;
      _internalForTests.setRequestTxnTimeoutMs();

      const killing = emit('kill');
      await until(async () => (await held('kill-marker')) === 1);
      heldBeforeKill = await held('kill-marker');
      const t0 = performance.now();
      await killing;
      await until(async () => (await held('kill-marker')) === 0);
      killMs = performance.now() - t0;

      // What every pooled connection is left as: all of them drawn at once.
      pooled = (
        await Promise.all(
          Array.from({ length: 20 }, () =>
            pool?.unsafe<{ u: string; r: string; t: string | null }>(
              "SELECT current_user AS u, current_setting('role') AS r, current_setting('zveltio.current_tenant', true) AS t, pg_sleep(0.05)::text",
            ),
          ),
        )
      ).flatMap((r) => r ?? []);
    } finally {
      _internalForTests.setRequestTxnTimeoutMs();
      await getWorkerHost(app).stopAll();
      await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    }
  }, 60_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved;
    extensionLoader.ctx = savedCtx;
    _resetWorkerHostForTests();
    await sql`DROP TABLE IF EXISTS ${sql.table(tbl('log'))}`.execute(db);
    await sql`DROP TABLE IF EXISTS ${sql.table(tbl('rows'))}`.execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT}::uuid`.execute(db).catch(() => undefined);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('a schedule commits when the callback resolves, as the worker role on one connection', async () => {
    expect(schedRows).toEqual(['sched-1', 'sched-2']);
    const ok = (await logged('sched')).ok as Who;
    expect(ok.role).not.toBe('none');
    // No request, no tenant: what a lone statement there runs as.
    expect(ok.t ?? '').toBe('');
  });

  it('a throwing callback in a schedule rolls back', async () => {
    expect(await logged('sched-throw')).toEqual({ err: 'no' });
    expect(await rows("who = 'sched-thrown'")).toEqual([]);
  });

  it("an event handler's transaction commits, nested db.transaction() is a savepoint", async () => {
    expect(await rows("who LIKE 'commit-%'")).toEqual(['commit-1', 'commit-2']);
    const { a, b } = (await logged('commit')).ok as { a: Who; b: Who };
    expect(a.pid).toBe(b.pid);
    // The scope a lone statement of the same handler runs as — not wider.
    const plain = (await logged('plain')) as Who;
    expect(a.t).toBe(TENANT);
    expect(plain.t).toBe(TENANT);
    expect(a.role).toBe(plain.role);
  });

  it('a throwing callback rolls back: nothing persisted', async () => {
    expect(await logged('throw')).toEqual({ err: 'boom' });
    expect(await rows("who = 'thrown'")).toEqual([]);
  });

  it('the hard timeout rolls back and releases the connection mid-callback', async () => {
    expect(heldMidSlow).toBe(0);
    expect((await logged('slow')).err).toContain('timed out after 400 ms');
    expect(await rows("who LIKE 'slow-%'")).toEqual([]);
  });

  it('two overlapping transactions run on two connections, isolated', async () => {
    const { a, b } = (await logged('pair')) as {
      a: { pid: number; sawOther: number };
      b: { pid: number; sawOther: number };
    };
    expect(a.pid).not.toBe(b.pid);
    // A peeked while B was still open; B peeked after A committed.
    expect(a.sawOther).toBe(0);
    expect(b.sawOther).toBe(1);
    expect((await rows("who LIKE 'pair-%'")).sort()).toEqual(['pair-a', 'pair-b']);
  });

  it('a worker killed mid-transaction rolls back and gives the connection back', async () => {
    // It was open, on the host, when the worker died.
    expect(heldBeforeKill).toBe(1);
    expect(await rows("who = 'kill-marker'")).toEqual([]);
    expect(await held('kill-marker')).toBe(0);
    expect(killMs).toBeLessThan(10_000);
  });

  it('no role or tenant GUC reaches the pool', () => {
    expect(pooled.length).toBe(20);
    for (const r of pooled) {
      expect(r.u).toBe(login);
      expect(r.r).toBe('none');
      expect(r.t ?? '').not.toBe(TENANT);
    }
  });
});
