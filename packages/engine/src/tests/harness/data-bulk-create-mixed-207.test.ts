/**
 * Phase C — bulk POST mixed validation 207 (handlers/bulk.ts per-row errors).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkc207_${Date.now()}`;

d('data bulk create mixed 207 (in-process)', () => {
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

  it('returns 207 when some records validate and others fail', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [{ label: 'ok-row', score: 1 }, { score: 2 }, { label: 'also-ok', score: 3 }],
      }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      created: number;
      records: unknown[];
      errors: Array<{ index: number; errors: string[] }>;
    };
    expect(body.created).toBe(2);
    expect(body.records).toHaveLength(2);
    expect(body.errors.some((e) => e.index === 1)).toBe(true);
  });
});
