/**
 * Phase C — bulk DELETE with all existing ids returns 200 (handlers/bulk.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkdel200_${Date.now()}`;

d('data bulk delete all success 200 (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let idA = '';
  let idB = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    for (const title of ['del-a', 'del-b']) {
      const create = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ title }),
      });
      expect(create.status).toBe(201);
      const body = (await create.json()) as { id?: string };
      if (title === 'del-a') idA = body.id ?? '';
      else idB = body.id ?? '';
    }
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
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

  it('returns 200 when every id exists and deletes cleanly', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ ids: [idA, idB] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deleted: number;
      ids: string[];
      aborted?: unknown[];
    };
    expect(body.deleted).toBe(2);
    expect(body.ids).toHaveLength(2);
    expect(body.aborted).toBeUndefined();
  });
});
