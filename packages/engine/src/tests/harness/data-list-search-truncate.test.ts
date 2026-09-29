/**
 * Phase C — list handler truncates long ?search= queries (handlers/list.ts fts trim).
 *
 * Requires FTS/trgm collection (richtext field) so ?search= hits the fts path.
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
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'subtitle', type: 'text', required: false, unique: false, indexed: false },
        { name: 'body', type: 'richtext', required: false, unique: false, indexed: false },
      ],
    } as never);

    const meta = await DDLManager.getCollection(db, COLLECTION);
    expect(meta?.has_trgm).toBe(true);

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'generic', subtitle: NEEDLE, body: 'content' }),
    });
    expect(create.status).toBe(201);
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

  it('finds matches with a short search token', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?search=${encodeURIComponent(NEEDLE)}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ subtitle?: string }> };
    expect(body.records.some((r) => r.subtitle === NEEDLE)).toBe(true);
  });

  it('matches on the first 500 characters of an over-long search', async () => {
    // list.ts trims the term to 500 characters before searching. A row holding
    // exactly those 500 is found only if the tail past them was dropped: the
    // whole 520-character term appears in no row.
    const head = `${NEEDLE}${'x'.repeat(500 - NEEDLE.length)}`;
    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'long', subtitle: head }),
    });
    expect(create.status).toBe(201);

    const res = await app.request(
      `/api/data/${COLLECTION}?search=${encodeURIComponent(`${head}${'y'.repeat(20)}`)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ subtitle?: string }> };
    expect(body.records.map((r) => r.subtitle)).toEqual([head]);
  });
});
