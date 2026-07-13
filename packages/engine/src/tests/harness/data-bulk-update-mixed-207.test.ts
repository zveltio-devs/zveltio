/**
 * Phase C — bulk PATCH partial success 207 (handlers/bulk.ts per-row errors).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulk207_${Date.now()}`;

d('data bulk update mixed 207 (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let goodId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'score', type: 'integer', required: false, unique: false, indexed: false },
      ],
    } as never);

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'good-row', score: 1 }),
    });
    expect(create.status).toBe(201);
    goodId = ((await create.json()) as { id: string }).id;
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

  it('returns 207 when some rows update and others fail validation or are missing', async () => {
    const missingId = '00000000-0000-4000-8000-000000000099';
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [
          { id: goodId, score: 5 },
          { id: missingId, score: 9 },
          { id: goodId, label: '' },
        ],
      }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      updated: number;
      errors: Array<{ index: number; id?: string; errors: string[] }>;
    };
    expect(body.updated).toBe(1);
    expect(body.errors.length).toBeGreaterThanOrEqual(2);
    expect(body.errors.some((e) => e.id === missingId)).toBe(true);
    expect(body.errors.some((e) => e.errors.join('').length > 0)).toBe(true);
  });
});
