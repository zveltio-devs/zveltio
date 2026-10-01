/**
 * Sync pull never skips the rows past a page boundary.
 *
 * Each collection is read `updated_at > since ORDER BY updated_at LIMIT 1000`,
 * and the response carried `serverTimestamp: Date.now()`. A client pulling
 * again `since` that timestamp never received row 1001 onward of a collection
 * that filled its page — nothing told it the page was full, and the cursor had
 * already moved past the rows it did not get. Rows that share an `updated_at`
 * (a bulk insert: `now()` is the transaction's start) cannot be paged by a
 * timestamp at all, so the cursor is `(updated_at, id)`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SPREAD = `hsyncpage_spread_${Date.now()}`;
const TIED = `hsyncpage_tied_${Date.now()}`;
const OLD = `hsyncpage_old_${Date.now()}`;
// More than one page (the route's limit is 1000 per collection).
const ROWS = 1200;

type PullBody = {
  changes: Array<{ collection: string; id: string }>;
  serverTimestamp: number;
  hasMore?: boolean;
  cursors?: Record<string, string>;
};

d('sync pull pages without losing rows', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const pull = async (body: Record<string, unknown>): Promise<PullBody> => {
    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as PullBody;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    for (const name of [SPREAD, TIED, OLD]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      } as never);
    }
    // One distinct millisecond per row, an hour in the past so no row is newer
    // than the `Date.now()` the old cursor used.
    await sql
      .raw(
        `INSERT INTO "zvd_${SPREAD}" (title, updated_at)
         SELECT 'r' || g, date_trunc('milliseconds', now()) - interval '1 hour'
                -- rows 991-1010 share one whole millisecond, across the page boundary
                + (CASE WHEN g BETWEEN 991 AND 1010 THEN 991 ELSE g END) * interval '1 millisecond'
         FROM generate_series(1, ${ROWS}) g`,
      )
      .execute(db);
    // One statement: every row carries the same `updated_at`.
    await sql
      .raw(
        `INSERT INTO "zvd_${TIED}" (title, updated_at)
         SELECT 'r' || g, now() - interval '1 hour' FROM generate_series(1, ${ROWS}) g`,
      )
      .execute(db);
    await sql
      .raw(
        `INSERT INTO "zvd_${OLD}" (title, updated_at)
         SELECT 'r' || g, now() - interval '60 days' + g * interval '1 millisecond'
         FROM generate_series(1, ${ROWS}) g`,
      )
      .execute(db);
  });

  afterAll(async () => {
    for (const name of [SPREAD, TIED, OLD]) {
      await sql.raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`).execute(db);
      await db.deleteFrom('zvd_collections').where('name', '=', name).execute();
    }
  });

  // The pre-cursor contract: `since` in, `serverTimestamp` out. A client that
  // knows nothing of `hasMore` pulls again from the timestamp it was given.
  it('a since-only client that re-pulls from serverTimestamp receives every row', async () => {
    const first = await pull({ collections: [`zvd_${SPREAD}`], since: 0 });
    expect(first.changes.length).toBe(1000);
    const second = await pull({ collections: [`zvd_${SPREAD}`], since: first.serverTimestamp });
    const ids = new Set([...first.changes, ...second.changes].map((ch) => ch.id));
    expect(ids.size).toBe(ROWS);
  });

  it('a cursor client pages through tied updated_at, each row exactly once', async () => {
    const seen: string[] = [];
    let cursors: Record<string, string> = {};
    for (let round = 0; round < 5; round++) {
      const body = await pull({ collections: [`zvd_${TIED}`], since: 0, cursors });
      seen.push(...body.changes.map((ch) => ch.id));
      cursors = { ...cursors, ...body.cursors };
      if (!body.hasMore) break;
    }
    expect(seen.length).toBe(ROWS);
    expect(new Set(seen).size).toBe(ROWS);
  });

  it('a finished cursor pulls nothing and says so', async () => {
    let cursors: Record<string, string> = {};
    for (let round = 0; round < 5; round++) {
      const body = await pull({ collections: [`zvd_${TIED}`], since: 0, cursors });
      cursors = { ...cursors, ...body.cursors };
      if (!body.hasMore) break;
    }
    const after = await pull({ collections: [`zvd_${TIED}`], since: 0, cursors });
    expect(after.changes.length).toBe(0);
    expect(after.hasMore).toBe(false);
    // The row position holds; only where its deletes are complete from moves on.
    const position = (cur?: string) => cur?.replace(/^d\d+:/, '');
    expect(position(after.cursors?.[`zvd_${TIED}`])).toBe(position(cursors[`zvd_${TIED}`]));
  });

  it('refuses a malformed cursor with 400 instead of failing the pull', async () => {
    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        collections: [`zvd_${TIED}`],
        since: 0,
        cursors: { [`zvd_${TIED}`]: 'not-a-cursor' },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('pages through rows older than the tombstone retention', async () => {
    const seen: string[] = [];
    let cursors: Record<string, string> = {};
    let done = false;
    for (let round = 0; round < 5 && !done; round++) {
      const body = await pull({ collections: [`zvd_${OLD}`], since: 0, cursors });
      seen.push(...body.changes.map((ch) => ch.id));
      cursors = { ...cursors, ...body.cursors };
      done = !body.hasMore;
    }
    expect(done).toBe(true);
    expect(new Set(seen).size).toBe(ROWS);

    // A full page leaves the deletes owed where they were: they are complete
    // only up to where this client's previous caught-up pull left them.
    const owed = `${(Date.now() - 29 * 86_400_000) * 1000}`;
    const page = await pull({
      collections: [`zvd_${OLD}`],
      since: 0,
      cursors: { [`zvd_${OLD}`]: `d${owed}:0:00000000-0000-0000-0000-000000000000` },
    });
    expect(page.hasMore).toBe(true);
    expect(page.cursors?.[`zvd_${OLD}`]).toStartWith(`d${owed}:`);
  });

  it('a since-only client restarted past the retention resumes from the page it got', async () => {
    const since = Date.now() - 40 * 86_400_000;
    const body = await pull({ collections: [`zvd_${OLD}`], since });
    expect((body as { resync?: Record<string, boolean> }).resync?.[`zvd_${OLD}`]).toBe(true);
    expect(body.hasMore).toBe(true);
    // Its rows are 60 days old: resuming from its own `since` would skip 200 of them.
    expect(body.serverTimestamp).toBeLessThan(since);
  });
});
