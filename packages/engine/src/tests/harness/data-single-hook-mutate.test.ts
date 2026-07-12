/**
 * Phase C — single-record handler pre-write hook mutate paths (handlers/single.ts).
 *
 * Drives HTTP create/patch/put with engineEvents.onBefore mutate → persisted fields.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hhookmut_${Date.now()}`;

d('data single handler hook mutate (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'tag', type: 'text', required: false, unique: false, indexed: false },
        { name: 'score', type: 'number', required: false, unique: false, indexed: false },
      ],
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

  it('persists fields merged by beforeInsert mutate on POST create', async () => {
    engineEvents.onBefore('record.beforeInsert', (p) => {
      p.mutate({ tag: 'hook-stamped', title: (p.data.title as string).toLowerCase() });
    });

    const res = await json('POST', `/api/data/${COLLECTION}`, { title: 'HELLO' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string; title?: string; tag?: string };
    expect(body.title).toBe('hello');
    expect(body.tag).toBe('hook-stamped');
    expect(body.id).toBeTruthy();

    const get = await json('GET', `/api/data/${COLLECTION}/${body.id}`);
    expect(get.status).toBe(200);
    const stored = (await get.json()) as { title?: string; tag?: string };
    expect(stored.title).toBe('hello');
    expect(stored.tag).toBe('hook-stamped');
  });

  it('persists fields merged by beforeUpdate mutate on PATCH', async () => {
    const create = await json('POST', `/api/data/${COLLECTION}`, { title: 'patch-base', score: 1 });
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { id: string }).id;

    engineEvents.onBefore('record.beforeUpdate', (p) => {
      p.mutate({ tag: 'patched', score: Number(p.patch.score ?? 0) + 10 });
    });

    const res = await json('PATCH', `/api/data/${COLLECTION}/${id}`, { score: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { score?: number; tag?: string };
    expect(body.score).toBe(13);
    expect(body.tag).toBe('patched');
  });

  it('persists fields merged by beforeUpdate mutate on PUT replace', async () => {
    const create = await json('POST', `/api/data/${COLLECTION}`, { title: 'put-base' });
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { id: string }).id;

    engineEvents.onBefore('record.beforeUpdate', (p) => {
      p.mutate({ tag: 'replaced' });
    });

    const res = await json('PUT', `/api/data/${COLLECTION}/${id}`, { title: 'put-new' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title?: string; tag?: string };
    expect(body.title).toBe('put-new');
    expect(body.tag).toBe('replaced');
  });
});
