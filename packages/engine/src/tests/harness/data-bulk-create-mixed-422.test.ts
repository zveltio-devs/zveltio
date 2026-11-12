/**
 * Phase C — bulk POST mixed validation: the batch is refused whole (ADR 0044).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkc422_${Date.now()}`;

d('data bulk create mixed refused (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

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

  it('returns 422 naming the invalid row and stores none when one record fails', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [{ label: 'ok-row', score: 1 }, { score: 2 }, { label: 'also-ok', score: 3 }],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Array<{ index: number; errors: string[] }> };
    expect(body.errors.map((e) => e.index)).toEqual([1]);
    const rows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id(`zvd_${COLLECTION}`)}`.execute(db);
    expect(rows.rows[0]!.n).toBe(0);
  });
});
