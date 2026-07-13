/**
 * Phase C — time-travel single GET must honour entity-access like live reads.
 * Regression: ?as_of= returned the revision snapshot without isAllowed(view).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `httent_${Date.now()}`;
const OWNER = 'harness-tt-entity-access';
const FUTURE = new Date(Date.now() + 60_000).toISOString();

d('time-travel entity access (in-process)', () => {
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

  it('returns 404 on GET ?as_of= when entity-access denies view', async () => {
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (record, _user, op) =>
        op === 'view' && (record as { title: string }).title === 'locked' ? 'deny' : 'allow',
    });

    const open = await app.request(
      `/api/data/${COLLECTION}/${openId}?as_of=${encodeURIComponent(FUTURE)}`,
      { headers: { cookie } },
    );
    expect(open.status).toBe(200);

    const locked = await app.request(
      `/api/data/${COLLECTION}/${lockedId}?as_of=${encodeURIComponent(FUTURE)}`,
      { headers: { cookie } },
    );
    expect(locked.status).toBe(404);
  });
});
