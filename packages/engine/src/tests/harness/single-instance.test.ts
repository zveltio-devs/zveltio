/**
 * Single-instance mode: of two engines without Valkey, only the newest serves.
 *
 * Without Valkey a revoked permission reaches only the process that revoked
 * it, so a second serving process answers from a stale cache. The instances
 * check each other through `zv_instances`; the older one drains, then refuses
 * everything but health.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import {
  beat,
  type Heartbeat,
  RETIRED_REASON,
  refuseWhenRetired,
  singleInstanceMode,
  startHeartbeat,
} from '../../lib/runtime/single-instance.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(20);
  return cond();
};

d('single-instance mode', () => {
  let db: Database;
  const started: Heartbeat[] = [];

  beforeAll(() => {
    db = createDb(URL!);
  });
  afterEach(async () => {
    for (const h of started.splice(0)) h.stop();
    await sql`DELETE FROM zv_instances`.execute(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  it('is declared, and only without Valkey', () => {
    expect(singleInstanceMode({ ZVELTIO_SINGLE_INSTANCE: '1' })).toBe(true);
    expect(singleInstanceMode({})).toBe(false);
    expect(singleInstanceMode({ ZVELTIO_SINGLE_INSTANCE: '1', VALKEY_URL: 'redis://c' })).toBe(
      false,
    );
  });

  it('a newer live instance supersedes an older one, never the reverse', async () => {
    const old = crypto.randomUUID();
    const neu = crypto.randomUUID();
    expect(await beat(db, old)).toBe(false);
    expect(await beat(db, neu)).toBe(false);
    expect(await beat(db, old)).toBe(true);
    expect(await beat(db, neu)).toBe(false);
  });

  it('a newer instance that stopped beating supersedes nothing', async () => {
    const old = crypto.randomUUID();
    const gone = crypto.randomUUID();
    await beat(db, old);
    await beat(db, gone);
    await sql`UPDATE zv_instances SET last_seen = clock_timestamp() - interval '1 minute'
               WHERE instance_id = ${gone}::uuid`.execute(db);
    expect(await beat(db, old)).toBe(false);
  });

  it('the older drains, then refuses all but health; the newer serves', async () => {
    let retiredCalls = 0;
    const older = startHeartbeat(db, {
      heartbeatMs: 50,
      graceMs: 200,
      onRetire: () => retiredCalls++,
    });
    started.push(older);
    await Bun.sleep(30); // its first row is written, with the earlier start
    const newer = startHeartbeat(db, { heartbeatMs: 50, graceMs: 200 });
    started.push(newer);

    // Draining: still serving while the load balancer moves over.
    await Bun.sleep(120);
    expect(older.retired()).toBe(false);

    expect(await until(() => older.retired())).toBe(true);
    expect(retiredCalls).toBe(1);
    await Bun.sleep(200);
    expect(newer.retired()).toBe(false);

    const app = (h: Heartbeat) => {
      const a = new Hono();
      a.use('*', refuseWhenRetired(h.retired));
      a.get('/api/health', (c) => c.json({ ok: true }));
      a.get('/health', (c) => c.json({ ok: true }));
      a.get('/api/health/ready', (c) => c.json({ ok: true }));
      a.get('/api/data/posts', (c) => c.json({ data: [] }));
      return a;
    };
    const oldApp = app(older);
    const read = await oldApp.request('/api/data/posts');
    expect(read.status).toBe(503);
    expect(((await read.json()) as { message: string }).message).toBe(RETIRED_REASON);
    // Readiness fails too, so a load balancer stops sending traffic here.
    expect((await oldApp.request('/api/health/ready')).status).toBe(503);
    expect((await oldApp.request('/api/health')).status).toBe(200);
    expect((await oldApp.request('/health')).status).toBe(200);
    expect((await app(newer).request('/api/data/posts')).status).toBe(200);
  });
});
