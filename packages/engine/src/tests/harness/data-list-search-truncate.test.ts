/**
 * Phase C — list handler truncates long ?search= queries (handlers/list.ts fts trim).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hsearcht_${Date.now()}`;
const NEEDLE = `needle-${Date.now()}`;

d('data list search truncation (in-process)', () => {
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

    await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: `${NEEDLE} item` }),
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

  it('still finds matches when search is padded beyond 500 characters', async () => {
    const pad = 'x'.repeat(520);
    const res = await app.request(
      `/api/data/${COLLECTION}?search=${encodeURIComponent(`${pad}${NEEDLE}`)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ title?: string }> };
    expect(body.records.some((r) => (r.title ?? '').includes(NEEDLE))).toBe(true);
  });
});
