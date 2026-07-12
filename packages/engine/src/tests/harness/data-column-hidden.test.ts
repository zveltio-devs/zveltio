/**
 * Phase C — hidden columns stripped on GET list + single (handlers/list.ts + single.ts).
 *
 * Session role is often unset (→ public); use role '*' mask with can_read: false.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hhid_${Date.now()}`;

d('data column hidden on read (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let recordId = '';
  let colPermId = '';
  let tableName = '';

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
    tableName = `zvd_${COLLECTION}`;

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'visible', secret: 'classified' }),
    });
    expect(create.status).toBe(201);
    recordId = ((await create.json()) as { id: string }).id;

    const perm = await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name: 'secret',
        role: '*',
        can_read: false,
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
      .raw(`DROP TABLE IF EXISTS "${tableName}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('omits hidden columns from list GET', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<Record<string, unknown>> };
    expect(body.records.length).toBeGreaterThan(0);
    const row = body.records.find((r) => r.id === recordId) ?? body.records[0]!;
    expect(row.title).toBe('visible');
    expect('secret' in row).toBe(false);
  });

  it('omits hidden columns from single GET', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const row = (await res.json()) as Record<string, unknown>;
    expect(row.title).toBe('visible');
    expect('secret' in row).toBe(false);
  });
});
