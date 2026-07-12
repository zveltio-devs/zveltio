/**
 * Phase C — single GET time-travel with no revision snapshot (handlers/single.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `httsnr_${Date.now()}`;
const GHOST_ID = '00000000-0000-4000-8000-000000000088';

d('data single time-travel no revision (in-process)', () => {
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

  it('returns 404 when no revision exists for the record at ?as_of=', async () => {
    const past = new Date(Date.now() - 300_000);
    const res = await app.request(
      `/api/data/${COLLECTION}/${GHOST_ID}?as_of=${encodeURIComponent(past.toISOString())}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail?: string; error?: string };
    const msg = body.detail ?? body.error ?? '';
    expect(msg.toLowerCase()).toContain('point in time');
  });
});
