// Sibling `db.transaction()` scopes in one worker request (or one host
// transaction) take turns, as inline (`db/trx-sequencer.ts`). The host names a
// worker's savepoints by stack depth, so two scopes run side by side under
// `Promise.all` stacked theirs: the one that ended first released or rolled back
// the other's savepoint, a throwing scope kept its writes, and a sibling's plain
// statement landed in the other's savepoint and was undone with it.
// Driven through the real loader, as a request to a tenant, over the process transport.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { ALL_COLLECTIONS_ACTOR, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const NAME = `wkrsib${SFX}`;
const TABLE = `zv_${NAME}_rows`;
const TENANT = crypto.randomUUID();

const ENTRY = `
const T = 'zv_${NAME}_rows';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A throws after B's savepoint is open, and B ends after A; a plain write lands in between.
const siblings = (db, p) => {
  const add = (who) => db.insertInto(T).values({ who: p + who }).execute();
  return Promise.allSettled([
    db.transaction().execute(async () => {
      await add('a1');
      await sleep(60);
      await add('a2');
      throw new Error('a fails');
    }),
    db.transaction().execute(async (trx) => {
      await trx.insertInto(T).values({ who: p + 'b1' }).execute();
      await sleep(120);
      await add('b2');
    }),
    (async () => {
      await sleep(30);
      await add('plain');
    })(),
  ]).then((r) => r.map((x) => x.status));
};
export default {
  name: '${NAME}',
  async register(app, ctx) {
    const db = ctx.db;
    // Outside a request: the host's own transaction, the siblings savepoints in it.
    const settled = await db.transaction().execute(() => siblings(db, 'reg-'));
    await db.insertInto(T).values({ who: 'reg-settled:' + settled.join(',') }).execute();
    app.post('/siblings', async (c) => c.json(await siblings(db, 'req-')));
  },
};
`;

const MIGRATION = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (id serial PRIMARY KEY, who text);`,
  '-- DOWN',
  `DROP TABLE IF EXISTS ${TABLE};`,
].join('\n');

d('sibling db.transaction() scopes in a worker take turns', () => {
  let db: Database;
  let base = '';
  let status = 0;
  let settled: unknown;
  let rows: string[] = [];
  const saved = process.env.ZVELTIO_EXT_TRANSPORT;
  const savedCtx = extensionLoader.ctx;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${TENANT}::uuid, ${`wkrsib-${SFX}`}, 'sib', 'active')`.execute(db);
    base = mkdtempSync(join(tmpdir(), 'wkr-sib-'));
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
    writeFileSync(join(dir, 'engine', 'migrations', '001_rows.sql'), MIGRATION);

    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    _resetWorkerHostForTests();
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
    extensionLoader.ctx =
      extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
    try {
      await extensionLoader.loadExtension(NAME, app, extensionLoader.ctx, base);
      expect(extensionLoader.getLastLoadError(NAME)).toBeUndefined();
      const res = await app.request(`/ext/${NAME}/siblings`, { method: 'POST' });
      status = res.status;
      settled = await res.json();
      rows = (await sql<{ who: string }>`SELECT who FROM ${sql.table(TABLE)}`.execute(db)).rows.map(
        (r) => r.who,
      );
    } finally {
      await getWorkerHost(app).stopAll();
      await revokeExtensionDbRoles(db, NAME, true).catch(() => undefined);
    }
  }, 60_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved;
    extensionLoader.ctx = savedCtx;
    _resetWorkerHostForTests();
    await sql`DROP TABLE IF EXISTS ${sql.table(TABLE)}`.execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${NAME}:%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT}::uuid`.execute(db).catch(() => undefined);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  const kept = (p: string) =>
    rows
      .filter((w) => w.startsWith(p))
      .map((w) => w.slice(p.length))
      .sort();

  it('in a request: the throwing scope is undone alone, the rest stands, the request answers', () => {
    expect({ status, settled }).toEqual({
      status: 200,
      settled: ['rejected', 'fulfilled', 'fulfilled'],
    });
    expect(kept('req-')).toEqual(['b1', 'b2', 'plain']);
  });

  it('in a host transaction outside a request: the same', () => {
    expect(kept('reg-')).toEqual(['b1', 'b2', 'plain', 'settled:rejected,fulfilled,fulfilled']);
  });
});
