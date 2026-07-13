/**
 * Phase C — bulk handlers reject valid JSON with the wrong body shape (handlers/bulk.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbshape_${Date.now()}`;

d('data bulk wrong body shape (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
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

  const bulk = (method: string, body: unknown) =>
    app.request(`/api/data/${COLLECTION}/bulk`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  it('returns 400 when bulk POST body omits records', async () => {
    const res = await bulk('POST', {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail?.toLowerCase()).toMatch(/records/);
  });

  it('returns 400 when bulk POST records is not an array', async () => {
    const res = await bulk('POST', { records: 'nope' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when bulk PATCH body omits records', async () => {
    const res = await bulk('PATCH', { ids: ['00000000-0000-4000-8000-000000000001'] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when bulk DELETE body omits ids', async () => {
    const res = await bulk('DELETE', {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail?.toLowerCase()).toMatch(/ids/);
  });
});
