/**
 * Phase C — bulk update/delete must enforce per-row entity-access, like single
 * PATCH/PUT/DELETE. Regression: bulkUpdate/bulkDelete never called
 * entityAccessRegistry.isAllowed, so a user could modify/delete rows they have
 * no row-level access to via the bulk endpoints (row-level authz bypass).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkent_${Date.now()}`;
const OWNER = 'harness-bulk-entity-access';

d('bulk entity-access enforcement (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let tableName = '';

  const post = async (title: string): Promise<string> => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title }),
    });
    return ((await res.json()) as { id: string }).id;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    tableName = `zvd_${COLLECTION}`;
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

  it('bulkUpdate blocks a row that entity-access denies, still updates the allowed one', async () => {
    const openId = await post('open-u');
    const lockedId = await post('locked-u');
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (record, _user, op) =>
        op === 'update' && (record as { title: string }).title === 'locked-u' ? 'deny' : 'allow',
    });

    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [
          { id: openId, title: 'open-updated' },
          { id: lockedId, title: 'HACKED' },
        ],
      }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      updated: number;
      errors: Array<{ id: string; errors: string[] }>;
    };
    expect(
      body.errors.some((e) => e.id === lockedId && e.errors.join(' ').includes('Forbidden')),
    ).toBe(true);

    // the denied row was NOT modified
    const locked = await sql<{ title: string }>`
      SELECT title FROM ${sql.id(tableName)} WHERE id = ${lockedId}
    `.execute(db);
    expect(locked.rows[0]?.title).toBe('locked-u');
  });

  it('bulkDelete reports denied rows under `forbidden` and does not delete them', async () => {
    const openId = await post('open-d');
    const lockedId = await post('locked-d');
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (record, _user, op) =>
        op === 'delete' && (record as { title: string }).title === 'locked-d' ? 'deny' : 'allow',
    });

    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ ids: [openId, lockedId] }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as { deleted: number; ids: string[]; forbidden?: string[] };
    expect(body.ids).toContain(openId);
    expect(body.forbidden ?? []).toContain(lockedId);

    // the denied row still exists
    const still = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id(tableName)} WHERE id = ${lockedId}
    `.execute(db);
    expect(still.rows[0]!.n).toBe(1);
  });
});
