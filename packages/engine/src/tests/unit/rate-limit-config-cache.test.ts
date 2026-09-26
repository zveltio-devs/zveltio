/**
 * Rate-limit config cache (middleware/rate-limit.ts).
 *
 * A missing row was never cached: every request carrying an api key with no
 * `apikey:<id>` override, which is nearly all of them, paid one config query.
 * And a bus reconnect did not drop cached limits, so a change published while
 * the subscriber was away waited out the 60 s TTL.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { _internalForTests as bus } from '../../lib/runtime/realtime-bus.js';
import { clearLocalRateLimitCache, rateLimit } from '../../middleware/rate-limit.js';

/** Counts config reads; `row` is what the table holds for any key. */
function countingDb(row: { window_ms: number; max_requests: number } | undefined) {
  const db = {
    reads: 0,
    selectFrom: () => q,
  };
  const q = {
    select: () => q,
    where: () => q,
    executeTakeFirst: async () => {
      db.reads++;
      return row;
    },
  };
  return db;
}

async function hit(db: ReturnType<typeof countingDb>, keyPrefix: string, times: number) {
  const app = new Hono();
  app.use('*', rateLimit({ keyPrefix, max: 5, windowMs: 60_000, db: db as never }));
  app.get('/p', (c) => c.text('ok'));
  for (let i = 0; i < times; i++) await app.request('/p');
}

afterEach(() => clearLocalRateLimitCache());

describe('rate-limit config cache', () => {
  it('caches a missing row, so a tier with no config is read once per TTL', async () => {
    const db = countingDb(undefined);
    await hit(db, `absent-${crypto.randomUUID()}`, 3);
    expect(db.reads).toBe(1);
  });

  it('a bus reconnect drops cached limits, so the next request reads the table', async () => {
    const db = countingDb({ window_ms: 60_000, max_requests: 7 });
    const key = `present-${crypto.randomUUID()}`;
    await hit(db, key, 2);
    expect(db.reads).toBe(1);

    bus.onBusReconnected();
    await Bun.sleep(20); // the clear runs behind a dynamic import

    await hit(db, key, 1);
    expect(db.reads).toBe(2);
  });
});
