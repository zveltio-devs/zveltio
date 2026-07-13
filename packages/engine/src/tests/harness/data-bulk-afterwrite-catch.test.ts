/**
 * Phase C — bulk handlers swallow afterWrite rejections (handlers/bulk.ts .catch).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import * as writePipeline from '../../lib/data/write-pipeline.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbaw_${Date.now()}`;

d('data bulk afterWrite catch (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let recordId = '';

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
    recordId = ((await create.json()) as { id: string }).id;
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

  afterEach(() => {
    spyOn(writePipeline, 'afterWrite').mockRestore();
  });

  const bulk = (method: string, body: unknown) =>
    app.request(`/api/data/${COLLECTION}/bulk`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  it('bulk create still returns 201 when afterWrite rejects', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(writePipeline, 'afterWrite').mockRejectedValue(new Error('side-effect down'));

    const res = await bulk('POST', { records: [{ label: 'bulk-aw', score: 2 }] });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes(`afterWrite(create, ${COLLECTION}/`)),
    ).toBe(true);
    warn.mockRestore();
  });

  it('bulk update still returns 200 when afterWrite rejects', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(writePipeline, 'afterWrite').mockRejectedValue(new Error('side-effect down'));

    const res = await bulk('PATCH', { records: [{ id: recordId, score: 99 }] });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes(`afterWrite(update, ${COLLECTION}/`)),
    ).toBe(true);
    warn.mockRestore();
  });

  it('bulk delete still returns 200 when afterWrite rejects', async () => {
    const extra = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'delete-me', score: 3 }),
    });
    const extraId = ((await extra.json()) as { id: string }).id;

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(writePipeline, 'afterWrite').mockRejectedValue(new Error('side-effect down'));

    const res = await bulk('DELETE', { ids: [extraId] });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes(`afterWrite(delete, ${COLLECTION}/`)),
    ).toBe(true);
    warn.mockRestore();
  });
});
