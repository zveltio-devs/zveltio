/**
 * Phase C — list handler cursor pagination deep paths (handlers/list.ts).
 *
 * Desc keyset cursor, malformed cursor fallback, and next_cursor chaining.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcurs_${Date.now()}`;

d('data list cursor deep paths (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'rank', type: 'integer', required: false, unique: false, indexed: false },
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
      ],
    } as never);

    for (let i = 1; i <= 6; i++) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ rank: i * 10, label: `row-${i}` }),
      });
    }
    // Three more at rank 30, so the keyset has ties to break by id.
    for (let i = 1; i <= 3; i++) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ rank: 30, label: `tie-${i}` }),
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  interface ListBody {
    records: Array<{ id: string; rank: number }>;
    next_cursor: string | null;
    pagination: { total?: number };
  }

  const list = (qs: string) => app.request(`/api/data/${COLLECTION}${qs}`, { headers: { cookie } });

  it('paginates with desc cursor keyset via next_cursor', async () => {
    const first = (await (await list('?limit=2&sort=rank&order=desc')).json()) as ListBody;
    expect(first.records).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();

    const second = await list(
      `?limit=2&sort=rank&order=desc&cursor=${encodeURIComponent(first.next_cursor!)}`,
    );
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as ListBody;
    expect(page2.records).toHaveLength(2);
    expect(page2.records[0]!.id).not.toBe(first.records[0]!.id);
    expect(page2.records.every((r) => r.rank <= first.records[1]!.rank)).toBe(true);
  });

  it('paginates with asc cursor keyset via next_cursor', async () => {
    const first = (await (await list('?limit=2&sort=rank&order=asc')).json()) as ListBody;
    expect(first.records).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();

    const second = await list(
      `?limit=2&sort=rank&order=asc&cursor=${encodeURIComponent(first.next_cursor!)}`,
    );
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as ListBody;
    expect(page2.records).toHaveLength(2);
    expect(page2.records[0]!.id).not.toBe(first.records[0]!.id);
    expect(page2.records.every((r) => r.rank >= first.records[1]!.rank)).toBe(true);
  });

  for (const order of ['asc', 'desc'] as const) {
    it(`walks every row exactly once by ${order} cursor, across ties`, async () => {
      // Two per page over nine rows, four of them sharing rank 30: a page
      // boundary lands inside the tie, where only the id tiebreak decides.
      const seen: string[] = [];
      let qs = `?limit=2&sort=rank&order=${order}`;
      for (let pages = 0; pages < 10; pages++) {
        const body = (await (await list(qs)).json()) as ListBody;
        seen.push(...body.records.map((r) => r.id));
        if (!body.next_cursor) break;
        // A keyset page with more behind it knows no total — it must not
        // report the length of what it fetched as one.
        if (qs.includes('cursor=')) expect(body.pagination.total).toBeUndefined();
        qs = `?limit=2&sort=rank&order=${order}&cursor=${encodeURIComponent(body.next_cursor)}`;
      }
      const all = (await (await list('?limit=100')).json()) as ListBody;
      expect(seen).toHaveLength(9);
      expect(new Set(seen).size).toBe(9);
      expect([...seen].sort()).toEqual(all.records.map((r) => r.id).sort());
    });
  }

  it('emits next_cursor on offset pagination when more pages exist', async () => {
    const body = (await (await list('?limit=2&page=1&sort=rank&order=asc')).json()) as ListBody;
    expect(body.records).toHaveLength(2);
    expect(body.next_cursor).toBeTruthy();
    expect(body.pagination.total).toBeGreaterThanOrEqual(6);
  });

  it('falls back to offset pagination when cursor is malformed', async () => {
    const res = await list('?limit=3&cursor=not-valid-base64url');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.length).toBeGreaterThanOrEqual(3);
    expect(body.pagination.total).toBeGreaterThanOrEqual(6);
  });
});
