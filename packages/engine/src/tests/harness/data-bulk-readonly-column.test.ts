/**
 * Phase C — bulk create/update must enforce column-level write permission,
 * like single POST/PATCH/PUT. Regression: bulkCreate/bulkUpdate skipped the
 * column-access filter, so a role denied write on a column could set it via the
 * bulk endpoints (privilege escalation) even though single-record writes block it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkro_${Date.now()}`;

d('bulk read-only column enforcement (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let colPermId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'secret', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    const perm = await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name: 'secret',
        role: '*',
        can_read: true,
        can_write: false,
      })
      .returning('id')
      .executeTakeFirst();
    colPermId = perm?.id ?? '';
    await invalidateColumnPermCache(COLLECTION);
  });

  afterAll(async () => {
    if (!db) return;
    if (colPermId) {
      await db
        .deleteFrom('zvd_column_permissions')
        .where('id', '=', colPermId)
        .execute()
        .catch(() => {});
    }
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

  it('bulkCreate reports a per-row error and does not write the read-only column', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [{ title: 'ok-row' }, { title: 'sneaky', secret: 'leak' }],
      }),
    });
    expect(res.status).toBe(207); // mixed: one created, one errored
    const body = (await res.json()) as {
      created: number;
      errors: Array<{ index: number; errors: string[] }>;
    };
    expect(body.created).toBe(1);
    const blockedErr = body.errors.find((e) => e.index === 1);
    expect(blockedErr?.errors.join(' ').toLowerCase()).toContain('read-only');

    // The read-only value never reached the table.
    const leaked = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id(`zvd_${COLLECTION}`)} WHERE secret = 'leak'
    `.execute(db);
    expect(leaked.rows[0]!.n).toBe(0);
  });

  it('bulkUpdate reports a per-row error for a read-only column', async () => {
    // seed a row to update
    const created = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'seed' }),
    });
    const id = ((await created.json()) as { id: string }).id;

    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ records: [{ id, secret: 'leak2' }] }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as { errors: Array<{ id: string; errors: string[] }> };
    expect(body.errors[0]?.errors.join(' ').toLowerCase()).toContain('read-only');

    const leaked = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id(`zvd_${COLLECTION}`)} WHERE secret = 'leak2'
    `.execute(db);
    expect(leaked.rows[0]!.n).toBe(0);
  });
});
