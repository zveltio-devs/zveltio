/**
 * Phase C — bulk handler deep paths (handlers/bulk.ts).
 *
 * Correct API shapes, 207 partial success, validation limits, and hook aborts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkd_${Date.now()}`;

d('data bulk handler deep paths (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let goodId = '';
  const fakeId = '00000000-0000-4000-8000-000000000099';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'score', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'seed', score: 1 }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as { id?: string };
    goodId = body.id ?? '';
    expect(goodId).toBeTruthy();
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

  it('returns 400 when PATCH body omits records array', async () => {
    const res = await bulk('PATCH', { ids: [goodId], data: { score: 2 } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when PATCH records contain invalid UUIDs', async () => {
    const res = await bulk('PATCH', { records: [{ id: 'not-uuid', score: 2 }] });
    expect(res.status).toBe(400);
  });

  it('returns 207 when PATCH mixes found and missing rows', async () => {
    const res = await bulk('PATCH', {
      records: [
        { id: goodId, score: 9 },
        { id: fakeId, score: 8 },
      ],
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      updated: number;
      errors: Array<{ id: string; errors: string[] }>;
    };
    expect(body.updated).toBe(1);
    expect(body.errors.some((e) => e.id === fakeId)).toBe(true);
  });

  it('returns 207 when bulk create has validation errors on one row', async () => {
    const res = await bulk('POST', {
      records: [{ label: 'ok', score: 1 }, { score: 2 }],
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      created: number;
      errors: Array<{ index: number; errors: string[] }>;
    };
    expect(body.created).toBe(1);
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 207 when beforeInsert aborts one row in a bulk create', async () => {
    engineEvents.onBefore('record.beforeInsert', (p) => {
      if ((p.data.label as string) === 'blocked') p.abort('quota');
    });

    const res = await bulk('POST', {
      records: [
        { label: 'allowed', score: 1 },
        { label: 'blocked', score: 2 },
      ],
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      created: number;
      errors: Array<{ index: number; errors: string[] }>;
    };
    expect(body.created).toBe(1);
    expect(body.errors.some((e) => e.errors.join('').includes('EXT_HOOK_ABORTED'))).toBe(true);
  });

  it('returns 207 when beforeDelete aborts one id in bulk delete', async () => {
    const extra = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'abort-me', score: 3 }),
    });
    const extraId = ((await extra.json()) as { id: string }).id;

    engineEvents.onBefore('record.beforeDelete', (p) => {
      if (p.id === extraId) p.abort('protected');
    });

    const res = await bulk('DELETE', { ids: [goodId, extraId] });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      deleted: number;
      aborted?: Array<{ id: string; reason: string }>;
    };
    expect(body.deleted).toBe(1);
    expect(body.aborted?.some((a) => a.id === extraId && a.reason === 'protected')).toBe(true);
  });

  it('returns 400 when DELETE ids are not valid UUIDs', async () => {
    const res = await bulk('DELETE', { ids: ['bad-id'] });
    expect(res.status).toBe(400);
  });
});
