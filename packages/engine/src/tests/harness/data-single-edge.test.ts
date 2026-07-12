/**
 * Phase C — single-record handler edge paths (handlers/single.ts).
 *
 * Invalid UUID short-circuit, malformed as_of on GET /:id, and a happy-path
 * single fetch after create — all in-process.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hsingle_${Date.now()}`;

d('data single-record edge cases (in-process)', () => {
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
      body: JSON.stringify({ title: 'single-target' }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as { record?: { id: string }; data?: { id: string } };
    recordId = body.record?.id ?? body.data?.id ?? '';
    expect(recordId).toBeTruthy();
  });

  afterAll(async () => {
    if (db) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', COLLECTION)
        .execute()
        .catch(() => {});
    }
  });

  it('returns 404 for a non-UUID id without hitting Postgres', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/not-a-uuid`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid as_of timestamp on GET /:id', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}?as_of=not-a-date`, {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/as_of/i);
  });

  it('fetches a single record by id', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: { id: string; title: string } };
    expect(body.record.id).toBe(recordId);
    expect(body.record.title).toBe('single-target');
  });
});
