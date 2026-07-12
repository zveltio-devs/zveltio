/**
 * Phase C — list time-travel excludes delete revisions (handlers/list.ts as_of branch).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hlttdel_${Date.now()}`;

d('data list time-travel deleted (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let recordId = '';
  let beforeDelete: string;
  let afterDelete: string;

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
      body: JSON.stringify({ title: 'alive' }),
    });
    expect(create.status).toBe(201);
    recordId = ((await create.json()) as { id: string }).id;
    expect(recordId).toBeTruthy();

    beforeDelete = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 50));

    const del = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(del.status);
    afterDelete = new Date().toISOString();
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

  it('includes a row in ?as_of= before its delete revision', async () => {
    const res = await app.request(
      `/api/data/${COLLECTION}?as_of=${encodeURIComponent(beforeDelete)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<{ id?: string }>;
      pagination: { total: number };
      time_travel?: { as_of: string };
    };
    expect(body.time_travel?.as_of).toBeDefined();
    expect(body.records.some((r) => r.id === recordId)).toBe(true);
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
  });

  it('excludes a row when latest revision up to ?as_of= is delete', async () => {
    const res = await app.request(
      `/api/data/${COLLECTION}?as_of=${encodeURIComponent(afterDelete)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<{ id?: string }>;
      pagination: { total: number };
      time_travel?: { as_of: string };
    };
    expect(body.time_travel?.as_of).toBeDefined();
    expect(body.records.some((r) => r.id === recordId)).toBe(false);
    expect(body.pagination.total).toBe(0);
  });
});
