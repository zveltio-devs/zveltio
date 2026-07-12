/**
 * Phase C — LIST in filter (handlers/list + query-parse).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hin_${Date.now()}`;

d('data list in filter (in-process)', () => {
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

    for (const label of ['alpha', 'beta', 'gamma']) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label }),
      });
    }
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

  it('filters with in on a text field via JSON filter', async () => {
    const filter = encodeURIComponent(JSON.stringify({ label: { in: ['alpha', 'gamma'] } }));
    const res = await app.request(`/api/data/${COLLECTION}?filter=${filter}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ label: string }> };
    const labels = body.records.map((r) => r.label).sort();
    expect(labels).toEqual(['alpha', 'gamma']);
  });
});
