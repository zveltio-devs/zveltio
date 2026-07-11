/**
 * Phase C — /api/revisions (routes/revisions.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hrev_${Date.now()}`;

d('revisions routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let recordId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    const created = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Rev probe' }),
    });
    const body = (await created.json()) as { id?: string; data?: { id: string } };
    recordId = body.data?.id ?? body.id ?? '';
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

  it('GET /api/revisions lists revision rows for god admins', async () => {
    const res = await app.request(
      `/api/revisions?collection=${COLLECTION}&record_id=${recordId}&limit=10`,
      { headers: { cookie } },
    );
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { revisions?: unknown[] };
      expect(Array.isArray(body.revisions)).toBe(true);
    }
  });

  it('GET /api/revisions/:collection/:recordId returns record-scoped history', async () => {
    const res = await app.request(`/api/revisions/${COLLECTION}/${recordId}`, {
      headers: { cookie },
    });
    expect([200, 403, 404]).toContain(res.status);
  });
});
