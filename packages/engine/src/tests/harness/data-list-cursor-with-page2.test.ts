/**
 * Phase C — cursor ignored when page !== 1 (handlers/list.ts useCursor guard).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcurp2_${Date.now()}`;

d('data list cursor with page>1 uses offset path (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'seq', type: 'integer', required: false, unique: false, indexed: false },
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
      ],
    } as never);

    for (let i = 1; i <= 5; i++) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ seq: i, label: `row-${i}` }),
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

  it('uses offset pagination when cursor is present but page is not 1', async () => {
    const first = await app.request(`/api/data/${COLLECTION}?limit=2&page=1&sort=seq&order=asc`, {
      headers: { cookie },
    });
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      records: Array<{ label: string }>;
      next_cursor: string | null;
    };
    expect(page1.records).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();

    const second = await app.request(
      `/api/data/${COLLECTION}?limit=2&page=2&sort=seq&order=asc&cursor=${encodeURIComponent(page1.next_cursor!)}`,
      { headers: { cookie } },
    );
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as { records: Array<{ label: string }> };
    expect(page2.records).toHaveLength(2);
    expect(page2.records[0]!.label).not.toBe(page1.records[0]!.label);
  });
});
