/**
 * Phase C — bulk PATCH validation errors per row → 207 (handlers/bulk.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbval207_${Date.now()}`;

d('data bulk update validation 207 (in-process)', () => {
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
        { name: 'contact', type: 'email', required: false, unique: false, indexed: false },
      ],
    } as never);

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'good', contact: 'ok@example.com' }),
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

  it('returns 207 when one row fails processInput validation and one succeeds', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [
          { id: goodId, contact: 'still-valid@example.com' },
          { id: '00000000-0000-4000-8000-000000000099', contact: 'not-an-email' },
        ],
      }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      updated: number;
      errors: Array<{ index: number; errors: string[] }>;
    };
    expect(body.updated).toBeGreaterThanOrEqual(1);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors.some((e) => e.errors.length > 0)).toBe(true);
  });
});
