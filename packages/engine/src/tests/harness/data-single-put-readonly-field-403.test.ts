/**
 * Phase C — PUT (replaceRecord) must enforce column-level write permission,
 * exactly like POST/PATCH. Regression: replaceRecord skipped the
 * getColumnAccess/filterWritableFields check, so a role denied write on a column
 * could overwrite it via PUT (privilege escalation) even though PATCH blocked it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hputro_${Date.now()}`;

d('data single PUT read-only field 403 (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let recordId = '';
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

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'visible' }),
    });
    expect(create.status).toBe(201);
    recordId = ((await create.json()) as { id: string }).id;
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

  it('returns 403 when PUT includes a read-only column for the role', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'changed', secret: 'nope' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail?: string; error?: string };
    const msg = body.detail ?? body.error ?? '';
    expect(msg.toLowerCase()).toContain('read-only');

    // Defense in depth: the read-only column must NOT have been written.
    const row = await sql<{ secret: string | null }>`
      SELECT secret FROM ${sql.id(`zvd_${COLLECTION}`)} WHERE id = ${recordId}
    `.execute(db);
    expect(row.rows[0]?.secret ?? null).toBeNull();
  });

  it('still allows a PUT that only touches writable columns', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'renamed' }),
    });
    expect([200, 201]).toContain(res.status);
  });
});
