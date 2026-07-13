/**
 * Phase C — bulk delete 207 when the batch mixes allowed, forbidden, and aborted rows
 * (handlers/bulk.ts forbidden + aborted response branches together).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkmix_${Date.now()}`;
const OWNER = 'harness-bulk-delete-mixed';

d('bulk delete mixed forbidden+aborted 207 (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let tableName = '';
  let deletableId = '';
  let forbiddenId = '';
  let abortedId = '';

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
    deletableId = await post('delete-me');
    forbiddenId = await post('forbidden-me');
    abortedId = await post('abort-me');
  });

  afterEach(() => {
    engineEvents.clearPreHooks();
    entityAccessRegistry.unregisterAll(OWNER);
  });

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

  it('returns 207 with deleted, forbidden, and aborted arrays in one batch', async () => {
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (record, _user, op) =>
        op === 'delete' && (record as { title: string }).title === 'forbidden-me'
          ? 'deny'
          : 'allow',
    });
    engineEvents.onBefore('record.beforeDelete', (p) => {
      if (p.id === abortedId) p.abort('retain');
    });

    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ ids: [deletableId, forbiddenId, abortedId] }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      deleted: number;
      ids: string[];
      forbidden?: string[];
      aborted?: Array<{ id: string; reason: string }>;
    };
    expect(body.deleted).toBe(1);
    expect(body.ids).toEqual([deletableId]);
    expect(body.forbidden ?? []).toContain(forbiddenId);
    expect(body.aborted?.some((a) => a.id === abortedId && a.reason === 'retain')).toBe(true);

    const remaining = await sql<{ id: string }>`
      SELECT id::text AS id FROM ${sql.id(tableName)} ORDER BY title
    `.execute(db);
    expect(remaining.rows.map((r) => r.id).sort()).toEqual([abortedId, forbiddenId].sort());
  });
});
