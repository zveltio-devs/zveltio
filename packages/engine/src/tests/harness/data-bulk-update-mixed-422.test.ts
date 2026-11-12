/**
 * Phase C — bulk PATCH with refused rows: the batch is refused whole (ADR 0044).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulk422_${Date.now()}`;

d('data bulk update mixed refused (in-process)', () => {
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

  it('returns 422 naming every refused row and updates none', async () => {
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
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      errors: Array<{ index: number; id?: string; errors: string[] }>;
    };
    // Every refused row, not only the first (ADR 0044).
    expect(body.errors.map((e) => e.index)).toEqual([1, 2]);
    expect(body.errors[0]!.id).toBe(missingId);
    // The valid row was not written either.
    const row = await sql<{ score: number }>`
      SELECT score FROM ${sql.id(`zvd_${COLLECTION}`)} WHERE id = ${goodId}`.execute(db);
    expect(Number(row.rows[0]!.score)).toBe(1);
  });
});
