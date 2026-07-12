/**
 * Phase C — list offset pagination emits next_cursor (handlers/list.ts offsetHasMore).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hloffnc_${Date.now()}`;

d('data list offset next_cursor (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    for (let i = 1; i <= 5; i++) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label: `row-${i}` }),
      });
      expect(res.status).toBe(201);
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

  it('returns next_cursor on page 1 when more rows exist beyond limit', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?page=1&limit=2`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<{ id: string }>;
      next_cursor: string | null;
      pagination: { total: number };
    };
    expect(body.records).toHaveLength(2);
    expect(body.pagination.total).toBeGreaterThanOrEqual(5);
    expect(body.next_cursor).toBeTruthy();
  });
});
