/**
 * Phase C — PATCH/PUT/DELETE short-circuit on non-UUID ids (handlers/single.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbadid_${Date.now()}`;

d('data single write invalid uuid (in-process)', () => {
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

  const badId = 'not-a-valid-uuid';

  it('returns 404 on PATCH with a non-UUID id', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${badId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 on PUT with a non-UUID id', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${badId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 on DELETE with a non-UUID id', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${badId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
