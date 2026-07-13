/**
 * Phase C — single-record handler pre-write hook rethrow (handlers/single.ts).
 *
 * Non-AbortHookError exceptions from engineEvents.runBefore propagate as 500.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hhreth_${Date.now()}`;

d('data single handler hook rethrow (in-process)', () => {
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

  afterEach(() => engineEvents.clearPreHooks());

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

  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('rethrows when beforeInsert throws a non-abort error on create', async () => {
    engineEvents.onBefore('record.beforeInsert', () => {
      throw new Error('hook blew up');
    });

    const res = await json('POST', `/api/data/${COLLECTION}`, { title: 'boom' });
    expect(res.status).toBe(500);
  });

  it('rethrows when beforeUpdate throws a non-abort error on patch', async () => {
    const create = await json('POST', `/api/data/${COLLECTION}`, { title: 'patch-me' });
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { id: string }).id;

    engineEvents.onBefore('record.beforeUpdate', () => {
      throw new Error('patch hook failed');
    });

    const res = await json('PATCH', `/api/data/${COLLECTION}/${id}`, { title: 'new' });
    expect(res.status).toBe(500);
  });

  it('rethrows when beforeDelete throws a non-abort error on delete', async () => {
    const create = await json('POST', `/api/data/${COLLECTION}`, { title: 'delete-me' });
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { id: string }).id;

    engineEvents.onBefore('record.beforeDelete', () => {
      throw new Error('delete hook failed');
    });

    const res = await json('DELETE', `/api/data/${COLLECTION}/${id}`);
    expect(res.status).toBe(500);
  });
});
