// One database transaction per request across the worker bridge (RFC
// extension-runner, step 8). Each bridged statement used to commit on its own
// and `db.transaction()` was refused, so a multi-statement write was not atomic.
// The experiment (docs/engine/rfc-extension-runner-experiment.md §4) measured two
// cases out of process, both reproduced here with a small fixture: a fiscal
// invoice number burned by a failed insert after the series UPDATE, and an
// orphan contact left by a failed organisation link. Plus: a savepoint rolled
// back keeps the outer work, a thrown handler rolls back, the hard timeout
// releases the connection, a worker killed mid-request rolls back and gives the
// connection back, and no role or tenant GUC reaches the next pooled query.
// Driven through the real loader, as a request to a tenant, over the process transport.
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
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';
import {
  _internalForTests,
  _resetWorkerHostForTests,
  getWorkerHost,
} from '../../lib/worker-extension-host.js';
import { ALL_COLLECTIONS_ACTOR, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const TRANSPORTS = ['process'] as const;
const TENANT = crypto.randomUUID();
const extName = (t: string) => `wkrtx${t[0]}${SFX}`;
const tbl = (t: string, s: string) => `zv_${extName(t)}_${s}`;

const entry = (name: string, t: string) => `
const T = (s) => 'zv_${name}_' + s;
export default {
  name: '${name}',
  async register(app, ctx) {
    const db = ctx.db;
    // finance/invoicing's claimNumber, then an insert that fails (22007).
    app.post('/invoice', async (c) => {
      const [n] = await db.query('UPDATE ' + T('series') + ' SET next_number = next_number + 1 WHERE id = 1 RETURNING next_number - 1 AS n');
      await db.query('INSERT INTO ' + T('invoices') + ' (number, issue_date) VALUES ($1, $2::date)', 'INV-' + n.n, 'not-a-date');
      return c.json({}, 201);
    });
    // crm's POST /contacts with an organisation that does not exist (23503).
    app.post('/contact', async (c) => {
      const [k] = await db.query('INSERT INTO ' + T('contacts') + " (first_name) VALUES ('orphan') RETURNING id");
      await db.query('INSERT INTO ' + T('links') + ' (contact_id, org_id) VALUES ($1, $2)', k.id, crypto.randomUUID());
      return c.json({}, 201);
    });
    app.post('/savepoint', async (c) => {
      const add = (who) => db.insertInto(T('contacts')).values({ first_name: who }).execute();
      await add('sp-before');
      await db.transaction().execute(async () => {
        await add('sp-outer');
        try {
          await db.transaction().execute(async (trx) => {
            await trx.insertInto(T('contacts')).values({ first_name: 'sp-inner' }).execute();
            // A failed statement inside the savepoint: rolled back to it, not the request.
            await db.query('SELECT 1/0');
          });
        } catch {}
      });
      try {
        await db.transaction().execute(async () => {
          await add('sp-thrown');
          throw new Error('no');
        });
      } catch {}
      await add('sp-after');
      return c.json({}, 201);
    });
    // finance/invoicing's duplicate series: the handler maps 23505 to 400. The
    // aborted request transaction ends as inline — nothing kept, the 400 stands.
    app.post('/dup', async (c) => {
      try {
        await db.query('INSERT INTO ' + T('series') + ' VALUES (1, 9)');
        return c.json({}, 201);
      } catch (e) {
        return c.json({ errno: e.errno }, e.errno === '23505' ? 400 : 500);
      }
    });
    app.post('/throw', async () => {
      await db.query('INSERT INTO ' + T('contacts') + " (first_name) VALUES ('thrown')");
      throw new Error('boom');
    });
    app.post('/slow', async (c) => {
      await db.query('INSERT INTO ' + T('contacts') + " (first_name) VALUES ('slow-marker')");
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await db.query('SELECT 1');
        return c.json({ second: 'ran' });
      } catch (e) {
        return c.json({ second: e.message });
      }
    });
    app.post('/crash', async () => {
      await db.query('INSERT INTO ' + T('contacts') + " (first_name) VALUES ('crash-marker')");
      setTimeout(() => { throw new Error('worker dies'); }, 50);
      await new Promise(() => {});
    });
    app.get('/whoami', async (c) => {
      const q = "SELECT pg_backend_pid() AS pid, current_user AS u, current_setting('zveltio.current_tenant', true) AS t";
      const [a] = await db.query(q);
      const [b] = await db.query(q);
      return c.json({ a, b });
    });
  },
};
`;

const MIGRATION = (t: string) =>
  [
    `CREATE TABLE IF NOT EXISTS ${tbl(t, 'series')} (id int PRIMARY KEY, next_number int NOT NULL);`,
    `INSERT INTO ${tbl(t, 'series')} VALUES (1, 5) ON CONFLICT DO NOTHING;`,
    `CREATE TABLE IF NOT EXISTS ${tbl(t, 'invoices')} (id serial PRIMARY KEY, number text, issue_date date);`,
    `CREATE TABLE IF NOT EXISTS ${tbl(t, 'contacts')} (id serial PRIMARY KEY, first_name text);`,
    `CREATE TABLE IF NOT EXISTS ${tbl(t, 'orgs')} (id uuid PRIMARY KEY);`,
    `CREATE TABLE IF NOT EXISTS ${tbl(t, 'links')} (contact_id int REFERENCES ${tbl(t, 'contacts')}(id), org_id uuid REFERENCES ${tbl(t, 'orgs')}(id));`,
    '-- DOWN',
    ...['links', 'orgs', 'contacts', 'invoices', 'series'].map(
      (s) => `DROP TABLE IF EXISTS ${tbl(t, s)};`,
    ),
  ].join('\n');

type Out = {
  invoice: { status: number; next: number; invoices: number };
  contact: { status: number; contacts: number };
  savepoint: { status: number; names: string[] };
  thrown: { status: number; rows: number };
  dup: { status: number; body: unknown };
  timeout: { heldMidRequest: number; status: number; rows: number };
  crash: { status: number; ms: number; rows: number; held: number };
  whoami: { a: Record<string, unknown>; b: Record<string, unknown> };
  pooled: { u: string; t: string | null; pid: number }[];
  login: string;
};

d('one transaction per request across the worker bridge', () => {
  let db: Database;
  let base = '';
  const out: Record<string, Out> = {};
  const saved = process.env.ZVELTIO_EXT_TRANSPORT;
  const savedCtx = extensionLoader.ctx;

  const count = async (t: string, s: string, where = 'true') =>
    Number(
      (
        await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM ${sql.table(tbl(t, s))} WHERE ${sql.raw(where)}`.execute(
          db,
        )
      ).rows[0]?.n,
    );
  /** Backends left `idle in transaction` on a statement naming `marker`. */
  const held = async (marker: string) =>
    Number(
      (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state LIKE 'idle in transaction%'
            AND query LIKE ${`%${marker}%`}`.execute(db)
      ).rows[0]?.n,
    );

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${TENANT}::uuid, ${`wkrtx-${SFX}`}, 'tx', 'active')`.execute(db);
    base = mkdtempSync(join(tmpdir(), 'wkr-tx-'));
    for (const transport of TRANSPORTS) {
      const name = extName(transport);
      const dir = join(base, name);
      mkdirSync(join(dir, 'engine', 'migrations'), { recursive: true });
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
        }),
      );
      writeFileSync(join(dir, 'engine', 'index.js'), entry(name, transport));
      writeFileSync(join(dir, 'engine', 'migrations', '001_tx.sql'), MIGRATION(transport));

      process.env.ZVELTIO_EXT_TRANSPORT = transport;
      _resetWorkerHostForTests();
      // As tenantMiddleware serves a request: the tenant's transaction held for it.
      const app = new Hono();
      app.use('*', (c, next) =>
        runWithDomain(TENANT, () =>
          withTenantIsolation(
            TENANT,
            async () => {
              c.set('tenant' as never, { id: TENANT } as never);
              await next();
            },
            { identity: ALL_COLLECTIONS_ACTOR },
          ),
        ),
      );
      getWorkerHost(app);
      const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
      extensionLoader.ctx = ctx;
      await extensionLoader.loadExtension(name, app, ctx, base);
      expect(extensionLoader.getLastLoadError(name)).toBeUndefined();
      const post = (p: string) => app.request(`/ext/${name}${p}`, { method: 'POST' });
      try {
        const invoice = await post('/invoice');
        const contact = await post('/contact');
        const savepoint = await post('/savepoint');
        const thrown = await post('/throw');
        const dupRes = await post('/dup');
        const dup = { status: dupRes.status, body: await dupRes.json() };
        const whoami = (await (await app.request(`/ext/${name}/whoami`)).json()) as Out['whoami'];
        // What every pooled connection is left as: all of them are drawn at once.
        const pool = getActiveBunPool();
        const pooled = await Promise.all(
          Array.from({ length: 20 }, () =>
            pool?.unsafe<Out['pooled'][number]>(
              "SELECT pg_backend_pid() AS pid, current_user AS u, current_setting('zveltio.current_tenant', true) AS t, pg_sleep(0.05)::text",
            ),
          ),
        );
        const [login] = (await pool?.unsafe<{ u: string }>('SELECT session_user AS u')) ?? [];

        _internalForTests.setRequestTxnTimeoutMs(400);
        const slow = post('/slow');
        await new Promise((r) => setTimeout(r, 1000));
        const heldMidRequest = await held('slow-marker');
        const slowRes = await slow;
        _internalForTests.setRequestTxnTimeoutMs();

        const t0 = performance.now();
        const crash = await post('/crash');
        const crashMs = performance.now() - t0;

        out[transport] = {
          invoice: {
            status: invoice.status,
            next: Number(
              (
                await sql<{
                  n: number;
                }>`SELECT next_number AS n FROM ${sql.table(tbl(transport, 'series'))}`.execute(db)
              ).rows[0]?.n,
            ),
            invoices: await count(transport, 'invoices'),
          },
          contact: {
            status: contact.status,
            contacts: await count(transport, 'contacts', "first_name = 'orphan'"),
          },
          savepoint: {
            status: savepoint.status,
            names: (
              await sql<{
                first_name: string;
              }>`SELECT first_name FROM ${sql.table(tbl(transport, 'contacts'))}
                WHERE first_name LIKE 'sp-%' ORDER BY id`.execute(db)
            ).rows.map((r) => r.first_name),
          },
          thrown: {
            status: thrown.status,
            rows: await count(transport, 'contacts', "first_name = 'thrown'"),
          },
          timeout: {
            heldMidRequest,
            status: slowRes.status,
            rows: await count(transport, 'contacts', "first_name = 'slow-marker'"),
          },
          crash: {
            status: crash.status,
            ms: crashMs,
            rows: await count(transport, 'contacts', "first_name = 'crash-marker'"),
            held: await held('crash-marker'),
          },
          dup,
          whoami,
          pooled: pooled.flatMap((r) => r ?? []),
          login: login?.u ?? '',
        };
      } finally {
        _internalForTests.setRequestTxnTimeoutMs();
        await getWorkerHost(app).stopAll();
        await revokeExtensionDbRoles(db, name, true).catch(() => undefined);
      }
    }
  }, 150_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved;
    extensionLoader.ctx = savedCtx;
    _resetWorkerHostForTests();
    for (const t of TRANSPORTS) {
      for (const s of ['links', 'orgs', 'contacts', 'invoices', 'series']) {
        await sql`DROP TABLE IF EXISTS ${sql.table(tbl(t, s))}`.execute(db);
      }
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${extName(t)}:%`}`.execute(db);
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT}::uuid`.execute(db).catch(() => undefined);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  for (const t of TRANSPORTS) {
    describe(t, () => {
      it('a failed insert after the series UPDATE burns no invoice number', () => {
        // Before: next_number 5 -> 6, a permanent gap in the fiscal series.
        expect(out[t]?.invoice.status).toBeGreaterThanOrEqual(400);
        expect(out[t]?.invoice).toMatchObject({ next: 5, invoices: 0 });
      });

      it('a failed organisation link leaves no orphan contact', () => {
        expect(out[t]?.contact.status).toBeGreaterThanOrEqual(400);
        expect(out[t]?.contact.contacts).toBe(0);
      });

      it('db.transaction() is a savepoint: rolled back, it keeps the outer work', () => {
        expect(out[t]?.savepoint).toEqual({
          status: 201,
          names: ['sp-before', 'sp-outer', 'sp-after'],
        });
      });

      it('a handler that throws rolls the request back, as inline', () => {
        expect(out[t]?.thrown).toEqual({ status: 500, rows: 0 });
      });

      it('a SQL error the handler catches keeps its answer: 400, not 500', () => {
        expect(out[t]?.dup).toEqual({ status: 400, body: { errno: '23505' } });
      });

      it('the hard timeout rolls back and releases the connection mid-request', () => {
        // Released while the handler still runs; its answer cannot claim the rows.
        expect(out[t]?.timeout).toEqual({ heldMidRequest: 0, status: 500, rows: 0 });
      });

      it('a worker killed mid-request rolls back and gives the connection back', () => {
        expect(out[t]?.crash).toMatchObject({ rows: 0, held: 0 });
        expect(out[t]?.crash.status).toBeGreaterThanOrEqual(500);
        // Not the 30 s route timeout.
        expect(out[t]?.crash.ms).toBeLessThan(10_000);
      });

      it("one connection per request, as the request's tenant and the worker role", () => {
        const { a, b } = out[t]?.whoami ?? { a: {}, b: {} };
        expect(a.pid).toBe(b.pid);
        expect(a.t).toBe(TENANT);
        expect(a.u).not.toBe(out[t]?.login);
      });

      it('no role or tenant GUC reaches the next pooled query', () => {
        const { pooled = [], login = '', whoami } = out[t] ?? ({} as Out);
        expect(pooled.map((r) => r.pid)).toContain(whoami?.a.pid as number);
        for (const r of pooled) {
          expect(r.u).toBe(login);
          expect(r.t ?? '').not.toBe(TENANT);
        }
      });
    });
  }
});
