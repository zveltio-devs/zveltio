/**
 * Phase C — bulk handler pre-write hook mutate paths (handlers/bulk.ts).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkmut_${Date.now()}`;

d('data bulk handler hook mutate (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let seedId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'tag', type: 'text', required: false, unique: false, indexed: false },
        { name: 'score', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'seed', score: 1 }),
    });
    expect(create.status).toBe(201);
    seedId = ((await create.json()) as { id: string }).id;
    expect(seedId).toBeTruthy();
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

  it('persists fields merged by beforeInsert mutate on bulk POST', async () => {
    engineEvents.onBefore('record.beforeInsert', (p) => {
      p.mutate({ tag: 'bulk-stamped', label: (p.data.label as string).toUpperCase() });
    });

    const res = await bulk('POST', {
      records: [
        { label: 'alpha', score: 1 },
        { label: 'beta', score: 2 },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      created: number;
      records: Array<{ label?: string; tag?: string }>;
    };
    expect(body.created).toBe(2);
    expect(body.records.every((r) => r.tag === 'bulk-stamped')).toBe(true);
    expect(body.records.map((r) => r.label).sort()).toEqual(['ALPHA', 'BETA']);
  });

  it('persists fields merged by beforeUpdate mutate on bulk PATCH', async () => {
    engineEvents.onBefore('record.beforeUpdate', (p) => {
      p.mutate({ tag: 'bulk-patch', score: Number(p.patch.score ?? 0) * 100 });
    });

    const res = await bulk('PATCH', {
      records: [{ id: seedId, score: 4 }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: number;
      records: Array<{ id?: string; score?: number; tag?: string }>;
    };
    expect(body.updated).toBe(1);
    const row = body.records.find((r) => r.id === seedId);
    expect(row?.score).toBe(400);
    expect(row?.tag).toBe('bulk-patch');
  });
});
