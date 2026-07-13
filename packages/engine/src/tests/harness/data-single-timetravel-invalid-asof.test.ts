/**
 * Phase C — single GET invalid as_of (handlers/single.ts time-travel guard).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `httinv_${Date.now()}`;

d('data single time-travel invalid as_of (in-process)', () => {
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

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'asof-target' }),
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

  it('returns 400 when as_of is not a valid date', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}?as_of=not-a-date`, {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string; error?: string };
    const msg = body.detail ?? body.error ?? '';
    expect(msg.toLowerCase()).toContain('as_of');
  });
});
