/**
 * Phase C — bulk delete when every id is entity-access forbidden (handlers/bulk.ts).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkfbd_${Date.now()}`;
const OWNER = 'harness-bulk-forbidden-only';

d('bulk delete forbidden-only 207 (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let tableName = '';
  let id1 = '';
  let id2 = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    tableName = `zvd_${COLLECTION}`;

    const post = async (title: string) => {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ title }),
      });
      return ((await res.json()) as { id: string }).id;
    };
    id1 = await post('one');
    id2 = await post('two');
  });

  afterEach(() => entityAccessRegistry.unregisterAll(OWNER));

  afterAll(async () => {
    if (!db) return;
    entityAccessRegistry.unregisterAll(OWNER);
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

  it('returns 207 with deleted 0 and forbidden ids when delete is denied for all rows', async () => {
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (_record, _user, op) => (op === 'delete' ? 'deny' : 'allow'),
    });

    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ ids: [id1, id2] }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as { deleted: number; forbidden?: string[] };
    expect(body.deleted).toBe(0);
    expect(body.forbidden ?? []).toEqual(expect.arrayContaining([id1, id2]));

    const still = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id(tableName)}
    `.execute(db);
    expect(still.rows[0]!.n).toBe(2);
  });
});
