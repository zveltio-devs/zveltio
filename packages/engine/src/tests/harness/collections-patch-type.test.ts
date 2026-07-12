/**
 * Phase C — PATCH field type change via collections route (field-type-conversions + DDL).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hptype_${Date.now()}`;

d('collections field type change (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'contact', type: 'text', required: false, unique: false, indexed: false }],
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

  it('PATCH /:name/fields/:field changes text → email in metadata and DDL', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/contact`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ new_type: 'email' }),
    });
    expect([200, 202]).toContain(res.status);

    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    const contact = fields.find((f: { name: string }) => f.name === 'contact');
    expect(contact?.type).toBe('email');

    const cols = await sql<{ udt_name: string }>`
      SELECT udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${`zvd_${COLLECTION}`}
        AND column_name = 'contact'
    `.execute(db);
    expect(cols.rows[0]?.udt_name).toBe('text');
  });
});
