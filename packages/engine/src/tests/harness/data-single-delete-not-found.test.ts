/**
 * Phase C — DELETE returns 404 when the record does not exist (handlers/single.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hdelmiss_${Date.now()}`;
const GHOST_ID = '00000000-0000-4000-8000-0000000000aa';

d('data single delete not found (in-process)', () => {
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

  it('returns 404 when deleting a valid UUID that is not in the table', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${GHOST_ID}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail?: string; error?: string };
    expect((body.detail ?? body.error ?? '').toLowerCase()).toContain('not found');
  });
});
