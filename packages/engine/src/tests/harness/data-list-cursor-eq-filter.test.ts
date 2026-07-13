/**
 * Phase C — cursor keyset with eq filter (handlers/list.ts keyset branch).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hceq_${Date.now()}`;

d('data list cursor + eq filter (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'tier', type: 'text', required: false, unique: false, indexed: false },
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'rank', type: 'integer', required: false, unique: false, indexed: false },
      ],
    } as never);

    for (const row of [
      { tier: 'gold', label: 'a', rank: 1 },
      { tier: 'gold', label: 'b', rank: 2 },
      { tier: 'gold', label: 'c', rank: 3 },
      { tier: 'silver', label: 'd', rank: 4 },
    ]) {
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
    records: Array<{ tier: string; rank: number }>;
    next_cursor: string | null;
  }

  const list = (qs: string) => app.request(`/api/data/${COLLECTION}${qs}`, { headers: { cookie } });

  it('paginates with cursor while eq filter is active', async () => {
    const filter = encodeURIComponent(JSON.stringify({ tier: { eq: 'gold' } }));
    const first = (await (
      await list(`?limit=2&sort=rank&order=asc&filter=${filter}`)
    ).json()) as ListBody;
    expect(first.records).toHaveLength(2);
    expect(first.records.every((r) => r.tier === 'gold')).toBe(true);
    expect(first.next_cursor).toBeTruthy();

    const second = await list(
      `?limit=2&sort=rank&order=asc&filter=${filter}&cursor=${encodeURIComponent(first.next_cursor!)}`,
    );
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as ListBody;
    expect(page2.records.every((r) => r.tier === 'gold')).toBe(true);
    expect(page2.records.length).toBeGreaterThanOrEqual(1);
  });
});
