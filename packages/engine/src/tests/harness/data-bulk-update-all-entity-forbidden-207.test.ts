/**
 * Phase C — bulk update when every row is entity-access forbidden (handlers/bulk.ts).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkufbd_${Date.now()}`;
const OWNER = 'harness-bulk-update-forbidden-only';

d('bulk update forbidden-only 207 (in-process)', () => {
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

  it('returns 207 with updated 0 when entity-access denies every row', async () => {
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (_record, _user, op) => (op === 'update' ? 'deny' : 'allow'),
    });

    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [
          { id: id1, title: 'new-one' },
          { id: id2, title: 'new-two' },
        ],
      }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      updated: number;
      errors: Array<{ id: string; errors: string[] }>;
    };
    expect(body.updated).toBe(0);
    expect(body.errors).toHaveLength(2);
    expect(body.errors.every((e) => e.errors.join(' ').includes('Forbidden'))).toBe(true);
  });
});
