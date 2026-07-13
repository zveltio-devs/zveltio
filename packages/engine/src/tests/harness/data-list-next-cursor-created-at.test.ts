/**
 * Phase C — list next_cursor uses created_at when sort field absent on row (handlers/list.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hncur_${Date.now()}`;

d('data list next_cursor created_at fallback (in-process)', () => {
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

    for (let i = 1; i <= 4; i++) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label: `row-${i}` }),
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

  it('emits next_cursor on default sort when more pages exist', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?limit=2&page=1`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<{ id: string; created_at?: string }>;
      next_cursor: string | null;
      pagination: { total?: number };
    };
    expect(body.records).toHaveLength(2);
    expect(body.next_cursor).toBeTruthy();
    expect(body.pagination.total).toBeGreaterThanOrEqual(4);

    const decoded = JSON.parse(Buffer.from(body.next_cursor!, 'base64url').toString('utf8')) as {
      id: string;
      val: string;
    };
    expect(decoded.id).toBe(body.records[1]!.id);
    expect(decoded.val).toBeTruthy();
  });
});
