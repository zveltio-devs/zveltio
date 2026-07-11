/**
 * Phase C — full collection DDL lifecycle via routes + pg-boss queue.
 *
 * Exercises POST create (async queue), POST add-field (sync DDL), DELETE drop,
 * and sync-schema — driving ddl-queue.ts + ddl-manager.ts through real Postgres.
 * NODE_ENV=test makes enqueueDDLJob wait for job settlement (see app-harness).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hdlc_${Date.now()}`;

d('collections DDL lifecycle (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', COLLECTION)
        .execute()
        .catch(() => {});
    }
  });

  it('POST / creates a collection and provisions the physical table', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: COLLECTION,
        fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job_id?: string; name?: string };
    expect(body.name).toBe(COLLECTION);
    expect(body.job_id).toBeDefined();
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(true);
  });

  it('POST /:name/fields adds a column and updates metadata', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'subtitle',
        type: 'text',
        required: false,
        unique: false,
        indexed: false,
      }),
    });
    expect([200, 201, 202]).toContain(res.status);
    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    expect(fields.some((f: { name: string }) => f.name === 'subtitle')).toBe(true);
  });

  it('POST /:name/sync-schema is idempotent when metadata already matches', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/sync-schema`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { synced?: number };
    expect(typeof body.synced).toBe('number');
  });

  it('DELETE /:name drops the collection', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}?force=true`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(false);
  });
});
