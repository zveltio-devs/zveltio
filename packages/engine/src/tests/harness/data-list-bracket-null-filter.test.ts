/**
 * Phase C — LIST bracket null filters (?note[is_null]=) via handlers/list.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbrnull_${Date.now()}`;

d('data list bracket null filters (in-process)', () => {
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
        { name: 'note', type: 'text', required: false, unique: false, indexed: false },
        { name: 'code', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    for (const row of [
      { label: 'with-note', note: 'present', code: 'X1' },
      { label: 'no-note', note: null, code: 'X2' },
      { label: 'no-code', note: 'ok', code: null },
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
    records: Array<{ label: string; note: string | null; code: string | null }>;
  }

  it('filters rows where note is null via bracket syntax', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?note[is_null]=true`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.note == null)).toBe(true);
    expect(body.records.some((r) => r.label === 'no-note')).toBe(true);
  });

  it('filters rows where code is not null via bracket syntax', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?code[is_not_null]=1`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.code != null)).toBe(true);
    expect(body.records.some((r) => r.label === 'with-note')).toBe(true);
  });
});
