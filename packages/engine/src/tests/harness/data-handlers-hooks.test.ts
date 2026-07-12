/**
 * Phase C — single-record handler pre-write hook abort paths (handlers/single.ts).
 *
 * Drives HTTP create/patch/delete with engineEvents.onBefore abort → 422.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hhooks_${Date.now()}`;

d('data single handler hook aborts (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let recordId = '';

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

  it('returns 422 EXT_HOOK_ABORTED when beforeInsert aborts create', async () => {
    engineEvents.onBefore('record.beforeInsert', (p) => p.abort('denied'));

    const res = await json('POST', `/api/data/${COLLECTION}`, { title: 'nope' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; status: number };
    expect(body.code).toBe('EXT_HOOK_ABORTED');
    expect(body.status).toBe(422);
  });

  it('returns 422 when beforeUpdate aborts patch', async () => {
    const create = await json('POST', `/api/data/${COLLECTION}`, { title: 'patch-target' });
    expect(create.status).toBe(201);
    recordId = ((await create.json()) as { id: string }).id;

    engineEvents.onBefore('record.beforeUpdate', (p) => p.abort('locked'));

    const res = await json('PATCH', `/api/data/${COLLECTION}/${recordId}`, { title: 'new' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('EXT_HOOK_ABORTED');
  });

  it('returns 422 when beforeDelete aborts delete', async () => {
    const create = await json('POST', `/api/data/${COLLECTION}`, { title: 'delete-target' });
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { id: string }).id;

    engineEvents.onBefore('record.beforeDelete', (p) => p.abort('retain'));

    const res = await json('DELETE', `/api/data/${COLLECTION}/${id}`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('EXT_HOOK_ABORTED');
  });
});
