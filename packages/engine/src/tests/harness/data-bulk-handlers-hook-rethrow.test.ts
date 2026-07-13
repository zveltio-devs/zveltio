/**
 * Phase C — bulk handler pre-write hook rethrow (handlers/bulk.ts).
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
const COLLECTION = `hbulkreth_${Date.now()}`;

d('data bulk handler hook rethrow (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let seedId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'seed' }),
    });
    expect(create.status).toBe(201);
    seedId = ((await create.json()) as { id: string }).id;
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

  const bulk = (method: string, body: unknown) =>
    app.request(`/api/data/${COLLECTION}/bulk`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  it('rethrows when beforeInsert throws a non-abort error on bulk create', async () => {
    engineEvents.onBefore('record.beforeInsert', () => {
      throw new Error('bulk create hook blew up');
    });

    const res = await bulk('POST', { records: [{ label: 'one' }, { label: 'two' }] });
    expect(res.status).toBe(500);
  });

  it('rethrows when beforeUpdate throws a non-abort error on bulk patch', async () => {
    engineEvents.onBefore('record.beforeUpdate', () => {
      throw new Error('bulk patch hook blew up');
    });

    const res = await bulk('PATCH', { records: [{ id: seedId, label: 'patched' }] });
    expect(res.status).toBe(500);
  });

  it('rethrows when beforeDelete throws a non-abort error on bulk delete', async () => {
    engineEvents.onBefore('record.beforeDelete', () => {
      throw new Error('bulk delete hook blew up');
    });

    const res = await bulk('DELETE', { ids: [seedId] });
    expect(res.status).toBe(500);
  });
});
