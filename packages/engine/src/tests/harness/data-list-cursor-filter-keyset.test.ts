/**
 * Phase C — list cursor keyset pagination combined with filters (handlers/list.ts).
 *
 * Exercises the useCursor branch where decodeCursor succeeds and filters are
 * applied inside the keyset Kysely query (neq/gte paths).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcursf_${Date.now()}`;

d('data list cursor + filter keyset (in-process)', () => {
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
        { name: 'tier', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    const rows = [
      { rank: 10, label: 'a', tier: 'gold' },
      { rank: 20, label: 'b', tier: 'silver' },
      { rank: 30, label: 'c', tier: 'gold' },
      { rank: 40, label: 'd', tier: 'bronze' },
      { rank: 50, label: 'e', tier: 'gold' },
      { rank: 60, label: 'f', tier: 'silver' },
    ];
    for (const row of rows) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(row),
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
    records: Array<{ id: string; rank: number; tier: string }>;
    next_cursor: string | null;
  }

  const list = (qs: string) => app.request(`/api/data/${COLLECTION}${qs}`, { headers: { cookie } });

  it('paginates with cursor while a neq filter is active', async () => {
    const filter = encodeURIComponent(JSON.stringify({ tier: { neq: 'bronze' } }));
    const first = (await (
      await list(`?limit=2&sort=rank&order=asc&filter=${filter}`)
    ).json()) as ListBody;
    expect(first.records).toHaveLength(2);
    expect(first.records.every((r) => r.tier !== 'bronze')).toBe(true);
    expect(first.next_cursor).toBeTruthy();

    const second = await list(
      `?limit=2&sort=rank&order=asc&filter=${filter}&cursor=${encodeURIComponent(first.next_cursor!)}`,
    );
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as ListBody;
    expect(page2.records.length).toBeGreaterThanOrEqual(1);
    expect(page2.records.every((r) => r.tier !== 'bronze')).toBe(true);
    expect(page2.records[0]!.rank).toBeGreaterThan(first.records[1]!.rank);
  });

  it('paginates with cursor while a gte filter is active', async () => {
    const filter = encodeURIComponent(JSON.stringify({ rank: { gte: 25 } }));
    const first = (await (
      await list(`?limit=2&sort=rank&order=desc&filter=${filter}`)
    ).json()) as ListBody;
    expect(first.records.every((r) => r.rank >= 25)).toBe(true);
    expect(first.next_cursor).toBeTruthy();

    const second = await list(
      `?limit=2&sort=rank&order=desc&filter=${filter}&cursor=${encodeURIComponent(first.next_cursor!)}`,
    );
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as ListBody;
    expect(page2.records.every((r) => r.rank >= 25)).toBe(true);
    if (page2.records.length > 0) {
      expect(page2.records[0]!.rank).toBeLessThanOrEqual(first.records[1]!.rank);
    }
  });
});
