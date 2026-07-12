/**
 * Phase C — POST add-field with indexed:true via ddl-queue route.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hidx_${Date.now()}`;

d('collections add indexed field route (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
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

  it('POST /:name/fields creates an indexed integer column', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'priority',
        type: 'integer',
        required: false,
        unique: false,
        indexed: true,
      }),
    });
    expect([200, 201, 202]).toContain(res.status);

    const idx = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = ${`zvd_${COLLECTION}`}
        AND indexname LIKE ${`%priority%`}
    `.execute(db);
    expect(idx.rows.length).toBeGreaterThanOrEqual(1);

    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    const priority = fields.find((f: { name: string }) => f.name === 'priority');
    expect(priority?.indexed).toBe(true);
  });
});
