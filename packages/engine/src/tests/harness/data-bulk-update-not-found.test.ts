/**
 * Phase C — bulk PATCH with valid UUIDs that do not exist (handlers/bulk.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbupmiss_${Date.now()}`;

d('data bulk update missing records (in-process)', () => {
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

  const bulk = (body: unknown) =>
    app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  it('returns 207 with per-row not-found errors when ids are valid but absent', async () => {
    const res = await bulk({
      records: [
        { id: '00000000-0000-4000-8000-000000000011', label: 'ghost', score: 1 },
        { id: '00000000-0000-4000-8000-000000000022', label: 'also-missing', score: 2 },
      ],
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      updated: number;
      errors: Array<{ id: string; errors: string[] }>;
    };
    expect(body.updated).toBe(0);
    expect(body.errors).toHaveLength(2);
    expect(body.errors.every((e) => e.errors.join('').toLowerCase().includes('not found'))).toBe(
      true,
    );
  });
});
