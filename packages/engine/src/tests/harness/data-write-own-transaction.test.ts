/**
 * A data API write runs in its caller's tenant transaction, or not at all.
 *
 * Handed none, the single-record handlers, the bulk handlers and the sync push
 * opened a transaction of their own on the pool (ADR 0035 slice 1). It was not
 * the tenant context's, so everything ADR 0035 says of a write was false there,
 * measured with this file before the fix:
 *
 *   - the realtime bus published the record before its COMMIT
 *     (`{"title":"detached","committed":false}`), and for a bulk batch whose
 *     events could not be enqueued, published rows the 503 then rolled back;
 *   - a `record.created` listener met no transaction (`inTrx: false`): `ctx.db`
 *     was the pool, not the write's (decision 8);
 *   - the data flow lost the race to the COMMIT and never ran ("could not read
 *     the record: Transaction is already committed").
 *
 * No caller reaches the data API without its transaction (the tenant middleware
 * opens one on every data route, a job opens one with `withTenantIsolation`),
 * so the branch is gone and such a write is refused.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _setBossForTests } from '../../lib/data/ddl-queue.js';
import { DDLManager, jobQueue } from '../../lib/data/index.js';
import { dataApiWriteDetached } from '../../lib/data/api-write.js';
import { bulkCreate } from '../../lib/data/handlers/bulk.js';
import type { RequestUser } from '../../lib/data/types.js';
import { problemOnError } from '../../lib/problem.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { realtimeBus } from '../../lib/runtime/realtime-bus.js';
import { getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import { WEBHOOK_QUEUE } from '../../lib/webhooks.js';
import { syncRoutes } from '../../routes/sync.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = `wtrx_${Date.now()}`;
const C = `${STAMP}_c`;

d('a data API write needs its tenant transaction (ADR 0035)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let hook = '';
  let flow = '';
  let user: RequestUser;
  /** Each realtime bus publish of this file's collection, and whether its row was committed then. */
  const published: Array<{ title: string; committed: boolean }> = [];
  /** Each `record.created` of this file's collection, and whether its listener met a transaction. */
  const listened: Array<{ title: string; inTrx: boolean }> = [];
  let unlisten = () => {};

  const committed = async (title: string) =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ${sql.table(`zvd_${C}`)} WHERE title = ${title}`.execute(db)
    ).rows[0]!.n > 0;
  const jobs = async (title: string) =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pgboss.job
         WHERE name = ${WEBHOOK_QUEUE} AND data->>'webhookId' = ${hook}
           AND data->'data'->>'title' = ${title}`.execute(db)
    ).rows[0]!.n;
  const runs = async () =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zv_flow_runs WHERE flow_id = ${flow}::uuid`.execute(db)
    ).rows[0]!.n;
  const of = <T extends { title: string }>(list: T[], title: string) =>
    list.filter((e) => e.title === title);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    const s = await app.request('/api/auth/get-session', { headers: { cookie: god } });
    user = ((await s.json()) as { user: RequestUser }).user;
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    hook = (
      await sql<{ id: string }>`
        INSERT INTO zvd_webhooks (tenant_id, name, url, events, collections, retry_attempts)
        VALUES (${DEFAULT_TENANT_ID}::uuid, ${STAMP}, 'https://93.184.216.34/wtrx',
                ARRAY['*']::text[], ARRAY[${C}]::text[], 1)
        RETURNING id::text AS id`.execute(db)
    ).rows[0]!.id;
    flow = (
      await sql<{ id: string }>`
        INSERT INTO zv_flows (name, trigger_type, trigger_config, is_active)
        VALUES (${STAMP}, 'on_create', ${JSON.stringify({ collection: C })}::jsonb, true)
        RETURNING id::text AS id`.execute(db)
    ).rows[0]!.id;
    const bus = realtimeBus();
    const publish = bus.publish.bind(bus);
    spyOn(bus, 'publish').mockImplementation(async (e) => {
      const ev = e as { collection?: string; data?: { title?: string } };
      if (ev.collection === C) {
        const title = String(ev.data?.title);
        published.push({ title, committed: await committed(title) });
      }
      return publish(e);
    });
    unlisten = engineEvents.on('record.created', (p) => {
      if (p.collection === C) {
        listened.push({
          title: String(p.record.title),
          inTrx: getCurrentTenantTrx() !== undefined,
        });
      }
    });
  }, 60_000);

  afterAll(async () => {
    unlisten();
    if (!db) return;
    await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${flow}::uuid`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_flows WHERE id = ${flow}::uuid`.execute(db).catch(() => {});
    await sql`DELETE FROM pgboss.job WHERE name = ${WEBHOOK_QUEUE} AND data->>'webhookId' = ${hook}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_webhooks WHERE id = ${hook}::uuid`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${C}" CASCADE`).execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${C}`.execute(db);
  });

  /** Wait for the after-commit work and the flow a write set off. */
  const settle = async (flowRunsAtLeast: number) => {
    for (let i = 0; i < 30 && (await runs()) < flowRunsAtLeast; i++) await Bun.sleep(100);
  };

  it('the control: a routed write publishes after its COMMIT, in reach of its listener and its flow', async () => {
    const before = await runs();
    const res = await app.request(`/api/data/${C}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ title: 'routed' }),
    });
    expect(res.status).toBe(201);
    await settle(before + 1);
    expect(of(published, 'routed')).toEqual([{ title: 'routed', committed: true }]);
    expect(of(listened, 'routed')).toEqual([{ title: 'routed', inTrx: true }]);
    expect(await jobs('routed')).toBe(1);
    expect(await runs()).toBe(before + 1);
  }, 30_000);

  const detached = (title: string, trx: Database | undefined) =>
    dataApiWriteDetached('create', db, {
      collection: C,
      id: '',
      body: async () => ({ title }),
      user,
      authType: 'session',
      trx,
      tenantId: trx ? DEFAULT_TENANT_ID : null,
    });

  it('a single write handed no tenant transaction is refused, and sets nothing off', async () => {
    const before = await runs();
    const res = await detached('detached', undefined);
    await settle(before + 1);
    expect(of(published, 'detached')).toEqual([]);
    expect(of(listened, 'detached')).toEqual([]);
    expect(res.status).toBe(500);
    expect(await committed('detached')).toBe(false);
    expect(await jobs('detached')).toBe(0);
    expect(await runs()).toBe(before);
  }, 30_000);

  it('nor is a transaction the caller opened on the pool its tenant transaction', async () => {
    const res = await db.transaction().execute((trx) => detached('own-trx', trx));
    await Bun.sleep(300);
    expect(of(published, 'own-trx')).toEqual([]);
    expect(of(listened, 'own-trx')).toEqual([]);
    expect(res.status).toBe(500);
    expect(await committed('own-trx')).toBe(false);
  }, 30_000);

  it('a bulk create and a sync push handed none are refused, and broadcast nothing', async () => {
    // The handlers mounted without the tenant middleware: no `tenantTrx`.
    const bare = new Hono();
    bare.onError(problemOnError);
    bare.use(async (c, next) => {
      c.set('user', user);
      c.set('authType', 'session');
      c.set('tenantTrx', null);
      await next();
    });
    bare.post('/data/:collection/bulk', (c) => bulkCreate(c, db));
    bare.route('/sync', syncRoutes(db, null));
    const send = (path: string, body: unknown) =>
      bare.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: god },
        body: JSON.stringify(body),
      });
    const bulk = () =>
      send(`/data/${C}/bulk`, { records: [{ title: 'gone-1' }, { title: 'gone-2' }] });

    // With no job queue the events cannot be enqueued, so the batch is rolled
    // back: its rows must not have been broadcast first.
    const real = jobQueue();
    _setBossForTests(null);
    let refused: Response;
    try {
      refused = await bulk();
    } finally {
      _setBossForTests(real);
    }
    await Bun.sleep(300);
    expect(published.filter((p) => p.title.startsWith('gone-'))).toEqual([]);
    expect(refused.status).toBe(500);

    // With the queue running, still refused.
    expect((await bulk()).status).toBe(500);
    const push = await send('/sync/push', {
      operations: [
        {
          collection: C,
          recordId: crypto.randomUUID(),
          operation: 'create',
          payload: { title: 'gone-sync' },
        },
      ],
    });
    expect(push.status).toBe(500);
    await Bun.sleep(300);
    expect(published.filter((p) => p.title.startsWith('gone-'))).toEqual([]);
    for (const title of ['gone-1', 'gone-2', 'gone-sync']) {
      expect(await committed(title)).toBe(false);
    }
  }, 30_000);
});
