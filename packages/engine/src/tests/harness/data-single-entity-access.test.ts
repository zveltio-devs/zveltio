/**
 * Phase C — per-record entity-access checks (handlers/single.ts).
 *
 * view deny → 404, update/delete deny → 403.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hent_${Date.now()}`;
const OWNER = 'harness-entity-access';

d('data single entity access (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let tableName = '';
  let openId = '';
  let lockedId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    tableName = `zvd_${COLLECTION}`;

    const post = (title: string) =>
      app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ title }),
      });

    openId = ((await (await post('open')).json()) as { id: string }).id;
    lockedId = ((await (await post('locked')).json()) as { id: string }).id;
    expect(openId).toBeTruthy();
    expect(lockedId).toBeTruthy();
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

  it('returns 404 on GET when entity-access denies view', async () => {
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (record, _user, op) =>
        op === 'view' && (record as { title: string }).title === 'locked' ? 'deny' : 'allow',
    });

    expect(
      (await app.request(`/api/data/${COLLECTION}/${openId}`, { headers: { cookie } })).status,
    ).toBe(200);
    expect(
      (await app.request(`/api/data/${COLLECTION}/${lockedId}`, { headers: { cookie } })).status,
    ).toBe(404);
  });

  it('returns 403 on PATCH when entity-access denies update', async () => {
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (_record, _user, op) => (op === 'update' ? 'deny' : 'allow'),
    });

    const res = await app.request(`/api/data/${COLLECTION}/${openId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'changed' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 on DELETE when entity-access denies delete', async () => {
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (_record, _user, op) => (op === 'delete' ? 'deny' : 'allow'),
    });

    const res = await app.request(`/api/data/${COLLECTION}/${openId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(403);
  });
});
