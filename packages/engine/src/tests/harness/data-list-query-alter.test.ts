/**
 * Phase C — list handler applies queryAlterRegistry alters (handlers/list.ts applyAlters),
 * and time travel (`?as_of=`, list and single) refuses rather than skip them:
 * a snapshot from `zv_revisions` is JSON, so an arbitrary Kysely alter cannot be
 * applied to it. A row the live read hid came back by adding `?as_of=` to the URL.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { queryAlterRegistry, TIME_TRAVEL_ALTERED } from '../../lib/data/query-alter.js';
import { readScope } from '../../lib/data/read-scope.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hqalt_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const ALTER_OWNER = 'harness-query-alter';
const FUTURE = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());

const keepOnly = (qb: any) => qb.where('label', '=', 'keep-me');

d('data list query-alter registry (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let dropId = '';
  let godId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    godId = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0].id;
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'score', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);

    for (const label of ['keep-me', 'drop-me', 'keep-me']) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label, score: 1 }),
      });
      expect(res.status).toBe(201);
      if (label === 'drop-me') dropId = ((await res.json()) as { id: string }).id;
    }
  });

  afterEach(() => {
    queryAlterRegistry.unregisterAll(ALTER_OWNER);
  });

  afterAll(async () => {
    queryAlterRegistry.unregisterAll(ALTER_OWNER);
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  const get = (path: string) =>
    app.request(`/api/data/${COLLECTION}${path}`, { headers: { cookie } });

  it('filters list rows through registered query alters', async () => {
    queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, keepOnly);
    const res = await get('');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ label: string }> };
    expect(body.records).toHaveLength(2);
    expect(body.records.every((r) => r.label === 'keep-me')).toBe(true);
    expect((await get(`/${dropId}`)).status).toBe(404);
  });

  it('refuses list ?as_of= when an alter restricts the collection', async () => {
    queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, keepOnly);
    const res = await get(`?as_of=${FUTURE}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toBe(TIME_TRAVEL_ALTERED);
  });

  it('refuses single ?as_of= when an alter restricts the collection', async () => {
    queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, keepOnly);
    expect((await get(`/${dropId}?as_of=${FUTURE}`)).status).toBe(403);
  });

  it('refuses ?as_of= when an alter throws (fail closed, not 500)', async () => {
    queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, () => {
      throw new Error('boom');
    });
    expect((await get(`?as_of=${FUTURE}`)).status).toBe(403);
    expect((await get(`/${dropId}?as_of=${FUTURE}`)).status).toBe(403);
  });

  it('serves ?as_of= when the alter exempts this user', async () => {
    queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, (qb, u: { id?: string }) =>
      u?.id === godId ? qb : keepOnly(qb),
    );
    const list = await get(`?as_of=${FUTURE}`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { records: Array<{ label: string }> };
    expect(body.records.map((r) => r.label)).toContain('drop-me');
    expect((await get(`/${dropId}?as_of=${FUTURE}`)).status).toBe(200);
  });

  it('serves ?as_of= when no alter is registered', async () => {
    expect((await get(`?as_of=${FUTURE}`)).status).toBe(200);
    const single = await get(`/${dropId}?as_of=${FUTURE}`);
    expect(single.status).toBe(200);
    expect(((await single.json()) as { record: { label: string } }).record.label).toBe('drop-me');
  });

  // A row that did not come through a query (a snapshot, a realtime event)
  // cannot have an alter applied, so the gate refuses it — even one the alter
  // would have kept.
  it('the read gate admits no in-memory row while an alter restricts the reader', async () => {
    const row = { label: 'keep-me' };
    expect(await (await readScope(db, COLLECTION, { id: godId }, 'session')).admits(row)).toBe(
      true,
    );
    queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, keepOnly);
    expect(await (await readScope(db, COLLECTION, { id: godId }, 'session')).admits(row)).toBe(
      false,
    );
  });

  // The `?as_of=` probe runs every alter; a live read, which applies them to its
  // query, must not pay for it. Extensions see each call.
  it('a live single read calls each alter once', async () => {
    let calls = 0;
    queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, (qb) => {
      calls++;
      return qb;
    });
    expect((await get(`/${dropId}`)).status).toBe(200);
    expect(calls).toBe(1);
  });
});
