/**
 * A12 (2026-11-22): revisions outlive a dropped collection. Created again under
 * the same name, the new collection served its predecessor's records through
 * `?as_of=` (list and single) and `/api/revisions` to whoever may read the new
 * one. And a snapshot page applied no filter or search: it answered every row
 * the caller may read, as if they had matched (ADR 0019 decision 6).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLL = `ttinc_${String(Date.now()).slice(-7)}`;
const fields = [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }];

d('time travel reads only the collection as it is now', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member = '';
  let oldId = '';
  let newId = '';
  const now = () => encodeURIComponent(new Date().toISOString());
  const get = async (path: string, cookie = member) => {
    const res = await app.request(path, { headers: { cookie } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const write = async (title: string) => {
    const res = await app.request(`/api/data/${COLL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, { name: COLL, fields } as never);
    oldId = await write('predecessor');
    await DDLManager.dropCollection(db, COLL, { force: true });
    await DDLManager.createCollection(db, { name: COLL, fields } as never);
    newId = await write('successor');
    member = (
      await createMemberSession(app, db, { grants: [{ collection: COLL, actions: ['read'] }] })
    ).cookie;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_revisions WHERE collection = ${COLL}`.execute(db).catch(() => {});
    await DDLManager.dropCollection(db, COLL, { force: true }).catch(() => {});
  });

  it('?as_of= lists the new collection, not the dropped one', async () => {
    const { status, body } = await get(`/api/data/${COLL}?as_of=${now()}`);
    expect(status).toBe(200);
    const ids = (body.records as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual([newId]);
    expect((body.pagination as { total: number }).total).toBe(1);
  });

  it('?as_of= on one record of the dropped collection is not found', async () => {
    expect((await get(`/api/data/${COLL}/${oldId}?as_of=${now()}`)).status).toBe(404);
    expect((await get(`/api/data/${COLL}/${newId}?as_of=${now()}`)).status).toBe(200);
  });

  it('/api/revisions shows no revision of the dropped collection', async () => {
    const { status, body } = await get(`/api/revisions?collection=${COLL}`, god);
    expect(status).toBe(200);
    const ids = (body.revisions as { record_id: string }[]).map((r) => r.record_id);
    expect(ids).toEqual([newId]);
  });

  it('?as_of= refuses a filter or a search it would not apply: 400', async () => {
    const nope = encodeURIComponent(JSON.stringify({ title: 'nope' }));
    for (const qs of [`filter=${nope}`, 'title[eq]=nope', 'search=nope']) {
      const { status } = await get(`/api/data/${COLL}?as_of=${now()}&${qs}`);
      expect(status).toBe(400);
    }
  });
});
