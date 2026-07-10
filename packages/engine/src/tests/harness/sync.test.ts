/**
 * Phase C — SDK sync routes driven through the in-process app.
 *
 * Exercises routes/sync.ts push/pull validation and a happy-path create on a
 * harness-provisioned collection. No separate engine process required.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const COLLECTION = `hsync_${Date.now()}`;

d('sync routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  const json = (path: string, body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DELETE FROM "zvd_${COLLECTION}"`)
      .execute(db)
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

  it('rejects unauthenticated push', async () => {
    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid push body', async () => {
    const res = await app.request('/api/sync/push', json('/api/sync/push', {}));
    expect(res.status).toBe(400);
  });

  it('push create on a real collection returns ok', async () => {
    const recordId = crypto.randomUUID();
    const res = await app.request(
      '/api/sync/push',
      json('/api/sync/push', {
        operations: [
          {
            collection: COLLECTION,
            recordId,
            operation: 'create',
            payload: { title: 'synced' },
            clientTimestamp: Date.now(),
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { recordId: string; status: string }[] };
    expect(body.results[0]?.status).toBe('ok');
    expect(body.results[0]?.recordId).toBe(recordId);
  });

  it('pull returns changes for the collection', async () => {
    const res = await app.request(
      '/api/sync/pull',
      json('/api/sync/pull', {
        collections: [COLLECTION],
        since: 0,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changes: unknown[]; serverTimestamp: number };
    expect(Array.isArray(body.changes)).toBe(true);
    expect(typeof body.serverTimestamp).toBe('number');
  });

  it('rejects system table writes via push', async () => {
    const res = await app.request(
      '/api/sync/push',
      json('/api/sync/push', {
        operations: [
          {
            collection: 'user',
            recordId: crypto.randomUUID(),
            operation: 'create',
            payload: { email: 'nope@test.local' },
            clientTimestamp: Date.now(),
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { status: string; error?: string }[] };
    expect(body.results[0]?.status).toBe('error');
  });
});
