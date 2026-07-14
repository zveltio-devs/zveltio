/**
 * Phase C — audit-trail tenant isolation (zv_revisions + time-travel).
 * zv_revisions stores a full JSONB snapshot of every write but had no tenant_id,
 * and every reader ran on a handle that can't isolate a table with no tenant_id:
 *   - GET /api/revisions (admin, per-tenant) listed every tenant's history;
 *   - time-travel `?as_of=` on the data list handler reconstructed records from
 *     another tenant's snapshots for ANY user with collection read access.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const STAMP = Date.now();
const COLLECTION = `riso_things_${STAMP}`;
const FOREIGN_RECORD_ID = '00000000-0000-4000-8000-0000000000c1';

d('revisions/time-travel tenant isolation (in-process)', () => {
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

    // My write (as the default tenant) → afterWrite records a revision.
    const created = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'mine-row' }),
    });
    expect(created.status).toBe(201);

    // Another tenant's history for the SAME collection, inserted directly.
    await sql`
      INSERT INTO zv_revisions (collection, record_id, action, data, user_id, tenant_id)
      VALUES (${COLLECTION}, ${FOREIGN_RECORD_ID}, 'create',
              ${JSON.stringify({ id: FOREIGN_RECORD_ID, title: 'foreign-row' })}::jsonb,
              NULL, ${OTHER_TENANT}::uuid)
    `.execute(db);
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
  });

  it('GET /api/revisions does not list another tenant’s history', async () => {
    const res = await app.request(`/api/revisions?collection=${COLLECTION}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { revisions: { record_id: string }[] }).revisions;
    const recordIds = rows.map((r) => r.record_id);
    expect(recordIds).not.toContain(FOREIGN_RECORD_ID);
    // my own write IS visible
    expect(rows.length).toBeGreaterThan(0);
  });

  it('time-travel ?as_of= does not reconstruct another tenant’s records', async () => {
    const asOf = new Date(Date.now() + 60_000).toISOString();
    const res = await app.request(`/api/data/${COLLECTION}?as_of=${encodeURIComponent(asOf)}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { title?: string }[] };
    const titles = body.records.map((r) => r.title);
    expect(titles).toContain('mine-row');
    expect(titles).not.toContain('foreign-row'); // the cross-tenant leak is closed
  });
});
