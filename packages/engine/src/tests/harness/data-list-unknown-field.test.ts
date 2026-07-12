/**
 * Phase C — list handler rejects unknown filter/sort fields (handlers/list.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hlunk_${Date.now()}`;

d('data list unknown field (in-process)', () => {
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

  it('returns 400 for unknown filter field in JSON filter', async () => {
    const filter = encodeURIComponent(JSON.stringify({ no_such_col: { eq: 'x' } }));
    const res = await app.request(`/api/data/${COLLECTION}?filter=${filter}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toContain("Unknown filter field: 'no_such_col'");
  });

  it('returns 400 for unknown sort field', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?sort=no_such_col`, {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toContain("Unknown sort field: 'no_such_col'");
  });
});
