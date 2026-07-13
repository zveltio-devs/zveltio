/**
 * Phase C — time-travel reads (?as_of=) must apply the same read authorization as
 * the live read path. Regression: getRecord/listRecords time-travel branches
 * returned the historical snapshot directly, without applyColumnAccess (and, for
 * single, without entity-access), so a role denied read on a column could read it
 * from history — an info-disclosure bypass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `httcol_${Date.now()}`;
const FUTURE = new Date(Date.now() + 60_000).toISOString();

d('time-travel column access (in-process)', () => {
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

    // Column that the role can WRITE but NOT READ → must be hidden from reads,
    // including time-travel.
    const perm = await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name: 'secret',
        role: '*',
        can_read: false,
        can_write: true,
      })
      .returning('id')
      .executeTakeFirst();
    colPermId = perm?.id ?? '';
    await invalidateColumnPermCache(COLLECTION);

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'visible', secret: 'topsecret' }),
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

  it('single GET ?as_of hides the unreadable column', async () => {
    const res = await app.request(
      `/api/data/${COLLECTION}/${recordId}?as_of=${encodeURIComponent(FUTURE)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: Record<string, unknown> };
    expect(body.record.title).toBe('visible');
    expect('secret' in body.record).toBe(false);
  });

  it('list ?as_of hides the unreadable column', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?as_of=${encodeURIComponent(FUTURE)}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Record<string, unknown>[] };
    const mine = body.records.find((r) => r.id === recordId);
    expect(mine).toBeDefined();
    expect('secret' in (mine as Record<string, unknown>)).toBe(false);
  });
});
