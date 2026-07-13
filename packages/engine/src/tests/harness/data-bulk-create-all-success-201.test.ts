/**
 * Phase C — bulk POST with all valid rows returns 201 (handlers/bulk.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulk201_${Date.now()}`;

d('data bulk create all success 201 (in-process)', () => {
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

  it('returns 201 when every row passes validation and hooks', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [
          { label: 'alpha', score: 1 },
          { label: 'beta', score: 2 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      created: number;
      records: Array<{ id: string }>;
      errors: unknown[];
    };
    expect(body.created).toBe(2);
    expect(body.records).toHaveLength(2);
    expect(body.errors).toHaveLength(0);
  });
});
