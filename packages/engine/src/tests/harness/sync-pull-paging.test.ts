/**
 * Sync pull never skips the rows past a page boundary.
 *
 * A collection returns at most 1000 rows per pull. Rows that share an
 * `updated_at` (a bulk insert: `now()` is the transaction's start) cannot be
 * paged by a timestamp at all, so the cursor is `(updated_at, id)`, and a pull
 * says `hasMore` until the client has read everything.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TIED = `hsyncpage_tied_${Date.now()}`;
const OLD = `hsyncpage_old_${Date.now()}`;
// More than one page (the route's limit is 1000 per collection).
const ROWS = 1200;

type PullBody = {
  changes: Array<{ collection: string; id: string }>;
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
    for (const name of [TIED, OLD]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      } as never);
    }
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
    for (const name of [TIED, OLD]) {
      await sql.raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`).execute(db);
      await db.deleteFrom('zvd_collections').where('name', '=', name).execute();
    }
  });

  it('a cursor client pages through tied updated_at, each row exactly once', async () => {
    const seen: string[] = [];
    let cursors: Record<string, string> = {};
    for (let round = 0; round < 5; round++) {
      const body = await pull({ collections: [`zvd_${TIED}`], cursors });
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
      const body = await pull({ collections: [`zvd_${TIED}`], cursors });
      cursors = { ...cursors, ...body.cursors };
      if (!body.hasMore) break;
    }
    const after = await pull({ collections: [`zvd_${TIED}`], cursors });
    expect(after.changes.length).toBe(0);
    expect(after.hasMore).toBe(false);
    // The row position holds; only where its deletes are complete from moves on.
    const position = (cur?: string) => cur?.replace(/^d\d+:/, '');
    expect(position(after.cursors?.[`zvd_${TIED}`])).toBe(position(cursors[`zvd_${TIED}`]));
  });

  it('refuses a malformed cursor with 400 instead of failing the pull', async () => {
    // The last: a position without where its deletes are complete from.
    for (const bad of [
      'not-a-cursor',
      `${Date.now() * 1000}:00000000-0000-0000-0000-000000000000`,
    ]) {
      const res = await app.request('/api/sync/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ collections: [`zvd_${TIED}`], cursors: { [`zvd_${TIED}`]: bad } }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('pages through rows older than the tombstone retention', async () => {
    const seen: string[] = [];
    let cursors: Record<string, string> = {};
    let done = false;
    for (let round = 0; round < 5 && !done; round++) {
      const body = await pull({ collections: [`zvd_${OLD}`], cursors });
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
      cursors: { [`zvd_${OLD}`]: `d${owed}:0:00000000-0000-0000-0000-000000000000` },
    });
    expect(page.hasMore).toBe(true);
    expect(page.cursors?.[`zvd_${OLD}`]).toStartWith(`d${owed}:`);
  });
});
