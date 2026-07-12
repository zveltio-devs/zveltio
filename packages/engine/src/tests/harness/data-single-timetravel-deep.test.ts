/**
 * Phase C — single-record time-travel deep paths (handlers/single.ts as_of branch).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `htts_${Date.now()}`;

d('data single time-travel deep (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let deletedId = '';

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
      body: JSON.stringify({ title: 'will-delete' }),
    });
    expect(create.status).toBe(201);
    deletedId = ((await create.json()) as { id: string }).id;

    const del = await app.request(`/api/data/${COLLECTION}/${deletedId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(del.status);
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

  it('returns 404 when as_of points after a delete revision', async () => {
    const res = await app.request(
      `/api/data/${COLLECTION}/${deletedId}?as_of=${encodeURIComponent(new Date().toISOString())}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail?: string; error?: string };
    const msg = body.detail ?? body.error ?? '';
    expect(msg.toLowerCase()).toContain('deleted');
  });

  it('reconstructs a snapshot when revision data is stored as a JSON string', async () => {
    const survivor = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'snapshot' }),
    });
    expect(survivor.status).toBe(201);
    const survivorId = ((await survivor.json()) as { id: string }).id;

    const past = new Date(Date.now() - 60_000);
    await db
      .insertInto('zv_revisions')
      .values({
        collection: COLLECTION,
        record_id: survivorId,
        action: 'update',
        data: JSON.stringify({ id: survivorId, title: 'from-string-json' }),
        created_at: past,
      })
      .execute();

    const res = await app.request(
      `/api/data/${COLLECTION}/${survivorId}?as_of=${encodeURIComponent(past.toISOString())}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      record?: { title?: string };
      time_travel?: { as_of: string };
    };
    expect(body.time_travel?.as_of).toBeDefined();
    expect(body.record?.title).toBe('from-string-json');
  });
});
