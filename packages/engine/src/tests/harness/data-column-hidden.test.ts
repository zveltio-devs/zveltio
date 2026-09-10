/**
 * Phase C — hidden columns stripped on GET list + single (handlers/list.ts + single.ts).
 *
 * Driven by a real `member`, not by the god session that sets the data up.
 *
 * It used to be driven entirely by god, and passed — because `getColumnAccess`
 * exempted the role NAME `admin` and let `god` fall through to being masked.
 * The suite was green on the strength of that inversion. Now that the exemption
 * is the `data:view_all_columns` permission, which god holds, a god session
 * sees every column and this suite could no longer observe masking at all.
 *
 * The rule is still written for role '*', because what is under test is the
 * masking, not role matching — `column-permissions-role.test.ts` covers that.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hhid_${Date.now()}`;

d('data column hidden on read (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let memberCookie = '';
  let recordId = '';
  let colPermId = '';
  let tableName = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    // Deny-by-default: without an explicit grant this user is refused 403,
    // which is not the masking this suite is about and reads like a pass.
    ({ cookie: memberCookie } = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read'] }],
    }));
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
    const res = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<Record<string, unknown>> };
    expect(body.records.length).toBeGreaterThan(0);
    const row = body.records.find((r) => r.id === recordId) ?? body.records[0]!;
    expect(row.title).toBe('visible');
    expect('secret' in row).toBe(false);
  });

  it('omits hidden columns from single GET', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as Record<string, unknown>;
    expect(row.title).toBe('visible');
    expect('secret' in row).toBe(false);
  });
});
