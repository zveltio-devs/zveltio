/**
 * Phase C — list handler refuses malformed ?filter JSON (handlers/list.ts virtual branch
 * and physical collections via parseFilters).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hlfilt_${Date.now()}`;

d('data list malformed filter JSON (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

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

    await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'alpha', score: 1 }),
    });
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

  // ADR 0019 decision 6: an unappliable filter is a 400, not every row.
  it('refuses ?filter that is not valid JSON', async () => {
    const res = await app.request(
      `/api/data/${COLLECTION}?filter=${encodeURIComponent('{ not json')}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });

  it('refuses an unknown operator in either form instead of listing every row', async () => {
    for (const q of [
      'label[near]=1',
      `filter=${encodeURIComponent('{"label":{"near":1}}')}`,
      'ghost[eq]=1',
    ]) {
      const res = await app.request(`/api/data/${COLLECTION}?${q}`, { headers: { cookie } });
      expect(res.status).toBe(400);
    }
  });
});
