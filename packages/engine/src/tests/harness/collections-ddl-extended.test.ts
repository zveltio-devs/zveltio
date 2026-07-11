/**
 * Phase C — collections preview, remove-field, PATCH field (routes/collections.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hdlex_${Date.now()}`;

d('collections DDL extended (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'notes', type: 'text', required: false, unique: false, indexed: false },
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

  it('POST /preview returns DDL SQL without executing', async () => {
    const res = await app.request('/api/collections/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'preview_only',
        fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sql: string[] };
    expect(Array.isArray(body.sql)).toBe(true);
    expect(body.sql.join('\n')).toContain('CREATE TABLE');
    expect(await DDLManager.tableExists(db, 'preview_only')).toBe(false);
  });

  it('DELETE /:name/fields/:field removes a column and updates metadata', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/notes`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    expect(fields.some((f: { name: string }) => f.name === 'notes')).toBe(false);
  });

  it('PATCH /:name/fields/:field toggles required on a field', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/title`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ required: false }),
    });
    expect([200, 202]).toContain(res.status);
    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    const title = fields.find((f: { name: string }) => f.name === 'title');
    expect(title?.required).toBe(false);
  });
});
