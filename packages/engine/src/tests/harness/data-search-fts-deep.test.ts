/**
 * Phase C — FTS search on LIST (?search=) with trgm-enabled collection.
 *
 * Creates a collection with multiple text fields (C/D FTS weights), seeds
 * distinctive phrases, and asserts ?search= returns the matching record.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hfts2_${Date.now()}`;
const UNIQUE = `unicorn-${Date.now()}`;

d('data FTS search deep (in-process)', () => {
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
        { name: 'footer', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'generic item', subtitle: 'boring' }),
    });
    await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'special',
        subtitle: UNIQUE,
        body: 'contains searchable phrase',
      }),
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

  interface ListBody {
    records: Array<{ title: string; subtitle?: string }>;
  }

  it('?search= finds the record whose subtitle contains the unique token', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?search=${encodeURIComponent(UNIQUE)}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.length).toBeGreaterThanOrEqual(1);
    expect(body.records.some((r) => r.subtitle === UNIQUE)).toBe(true);
  });
});
