/**
 * Phase C — bulk create when every row touches a read-only column (handlers/bulk.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkallro_${Date.now()}`;

d('bulk create all read-only errors (in-process)', () => {
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

  it('returns 207 with created 0 when every row includes a read-only field', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [
          { title: 'a', secret: 'x' },
          { title: 'b', secret: 'y' },
        ],
      }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      created: number;
      errors: Array<{ index: number; errors: string[] }>;
    };
    expect(body.created).toBe(0);
    expect(body.errors).toHaveLength(2);
    expect(body.errors.every((e) => e.errors.join(' ').toLowerCase().includes('read-only'))).toBe(
      true,
    );
  });
});
