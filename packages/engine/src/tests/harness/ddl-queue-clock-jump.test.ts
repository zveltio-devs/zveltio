/**
 * The DDL queue keeps polling when the wall clock jumps back.
 *
 * Every pg-boss worker times its own poll: `started = now()`, fetch, then sleep
 * `interval - (now() - started)`. Timed on `Date.now`, a poll that STARTED while
 * the clock read ahead and ENDED after it came back measured a negative
 * duration, and slept the interval plus the whole jump. In production that is
 * an NTP step back; in `bun test` it is a harness file moving `Date.now` (DR-40's
 * `list-pool-stall.test.ts` moves it 301 s per read): every harness file shares
 * one process and one queue, so each later `POST /api/collections` answered 400
 * after 30 s for the rest of the run — Handler Coverage, the non-superuser and
 * the pg-driver lanes, from 2026-11-15.
 *
 * Here the jump is made deterministic: the job table is locked so every worker's
 * fetch is still in flight when the clock comes back.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const C = `clockjump_${Date.now()}`;

d('DDL queue under a wall-clock jump', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db) await dropTestCollection(db, C);
  }, 60_000);

  it('a poll begun while the clock read an hour ahead does not sleep that hour', async () => {
    const real = Date.now;
    await db.transaction().execute(async (trx) => {
      Date.now = () => real() + 3_600_000;
      try {
        await sql`LOCK TABLE pgboss.job IN ACCESS EXCLUSIVE MODE`.execute(trx);
        // Longer than pg-boss's 2 s default poll: every DDL worker starts a fetch
        // on the forward clock and blocks on the lock.
        await Bun.sleep(2_500);
      } finally {
        Date.now = real;
      }
    });
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: C,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      }),
    });
    const body = res.status === 202 ? '' : await res.text();
    expect({ status: res.status, body }).toEqual({ status: 202, body: '' });
  }, 60_000);
});
