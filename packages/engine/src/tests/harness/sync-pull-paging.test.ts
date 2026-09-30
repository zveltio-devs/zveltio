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
    for (const name of [SPREAD, TIED]) {
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
         SELECT 'r' || g, now() - interval '1 hour' + g * interval '1 millisecond'
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
  });

  afterAll(async () => {
    for (const name of [SPREAD, TIED]) {
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
    expect(after.cursors?.[`zvd_${TIED}`]).toBe(cursors[`zvd_${TIED}`]);
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
});
