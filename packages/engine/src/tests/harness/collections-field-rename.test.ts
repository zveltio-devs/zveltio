/**
 * Phase C — PATCH field rename via collections route (ddl-manager + routes).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hren_${Date.now()}`;

d('collections field rename (in-process)', () => {
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

  it('PATCH /:name/fields/:field renames a column in metadata and DDL', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/label`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ new_name: 'headline' }),
    });
    expect([200, 202]).toContain(res.status);

    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    expect(fields.some((f: { name: string }) => f.name === 'headline')).toBe(true);
    expect(fields.some((f: { name: string }) => f.name === 'label')).toBe(false);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${`zvd_${COLLECTION}`}
        AND column_name IN ('label', 'headline')
    `.execute(db);
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain('headline');
    expect(names).not.toContain('label');
  });
});
