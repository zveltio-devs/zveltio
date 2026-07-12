/**
 * Phase C — single handler processInput validation → 422 (handlers/single.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hval422_${Date.now()}`;

d('data single validation 422 (in-process)', () => {
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
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'amount', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'seed', amount: 1 }),
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

  const json = (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  it('returns 422 with errors array when POST create has invalid number field', async () => {
    const res = await json('POST', `/api/data/${COLLECTION}`, {
      title: 'bad-amount',
      amount: 'not-a-number',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors?: string[] };
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors?.some((e) => e.includes('Must be a number'))).toBe(true);
  });

  it('returns 422 with errors array when PATCH has invalid number field', async () => {
    const res = await json('PATCH', `/api/data/${COLLECTION}/${recordId}`, {
      amount: 'still-not-a-number',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors?: string[] };
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors?.some((e) => e.includes('Must be a number'))).toBe(true);
  });
});
