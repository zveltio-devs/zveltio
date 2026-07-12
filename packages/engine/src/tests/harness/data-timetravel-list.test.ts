/**
 * Phase C — data LIST time-travel via zv_revisions (handlers/list.ts as_of branch).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `httl_${Date.now()}`;

d('data list time-travel (in-process)', () => {
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

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'revision-v1' }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as { id?: string };
    recordId = body.id ?? '';
    expect(recordId).toBeTruthy();

    const patch = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'revision-v2' }),
    });
    expect([200, 204]).toContain(patch.status);
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zv_revisions')
      .where('collection', '=', COLLECTION)
      .execute()
      .catch(() => {});
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

  it('reconstructs list state from zv_revisions for ?as_of=', async () => {
    const res = await app.request(
      `/api/data/${COLLECTION}?as_of=${encodeURIComponent(new Date().toISOString())}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<{ id?: string; title?: string }>;
      time_travel?: { as_of: string };
      pagination: { total: number };
    };
    expect(body.time_travel?.as_of).toBeDefined();
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    const match = body.records.find((r) => r.id === recordId);
    expect(match?.title).toBe('revision-v2');
  });
});
