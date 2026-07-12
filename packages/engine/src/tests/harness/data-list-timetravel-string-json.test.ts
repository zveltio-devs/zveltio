/**
 * Phase C — list time-travel parses string JSON revision snapshots (handlers/list.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hlttstr_${Date.now()}`;

d('data list time-travel string JSON (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let recordId = '';
  const past = new Date(Date.now() - 120_000);

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
      body: JSON.stringify({ title: 'live-title' }),
    });
    expect(create.status).toBe(201);
    recordId = ((await create.json()) as { id: string }).id;

    await db
      .insertInto('zv_revisions')
      .values({
        collection: COLLECTION,
        record_id: recordId,
        action: 'update',
        data: JSON.stringify({ id: recordId, title: 'past-title' }),
        created_at: past,
      })
      .execute();
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zv_revisions')
      .where('collection', '=', COLLECTION)
      .execute()
      .catch(() => {});
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

  it('reconstructs list rows when revision data is a JSON string', async () => {
    const res = await app.request(
      `/api/data/${COLLECTION}?as_of=${encodeURIComponent(past.toISOString())}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<{ id?: string; title?: string }>;
      time_travel?: { as_of: string };
    };
    expect(body.time_travel?.as_of).toBeDefined();
    const row = body.records.find((r) => r.id === recordId);
    expect(row?.title).toBe('past-title');
  });
});
