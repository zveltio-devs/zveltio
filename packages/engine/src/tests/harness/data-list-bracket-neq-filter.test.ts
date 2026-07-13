/**
 * Phase C — LIST bracket neq filter (?tier[neq]=) via handlers/list.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbrneq_${Date.now()}`;

d('data list bracket neq filter (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'name', type: 'text', required: true, unique: false, indexed: false },
        { name: 'tier', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    for (const row of [
      { name: 'alpha', tier: 'gold' },
      { name: 'beta', tier: 'bronze' },
      { name: 'gamma', tier: 'silver' },
    ]) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(row),
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

  interface ListBody {
    records: Array<{ name: string; tier: string | null }>;
  }

  it('excludes rows matching tier[neq]=bronze', async () => {
    const res = await app.request(
      `/api/data/${COLLECTION}?${encodeURIComponent('tier[neq]')}=bronze`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.tier !== 'bronze')).toBe(true);
    expect(body.records.some((r) => r.name === 'alpha')).toBe(true);
    expect(body.records.some((r) => r.name === 'gamma')).toBe(true);
  });
});
