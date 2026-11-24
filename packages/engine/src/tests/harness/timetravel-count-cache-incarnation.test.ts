/**
 * A12 (2026-11-22): the remembered `?as_of=` total was keyed without the
 * collection's incarnation. Dropped and created again under the same name, the
 * new collection counts only revisions written since its create
 * (`sinceCreated`), yet the same caller asking the same instant within the
 * cache TTL got the predecessor's total.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type Redis from 'ioredis';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { FakeRedis } from '../../testing/fake-redis.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLL = `ttcc_${String(Date.now()).slice(-7)}`;
const fields = [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }];

d('the remembered as_of total belongs to one incarnation', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let asOf = '';
  const total = async () => {
    const res = await app.request(`/api/data/${COLL}?as_of=${encodeURIComponent(asOf)}`, {
      headers: { cookie: god },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { pagination: { total: number } }).pagination.total;
  };
  const write = async (title: string) => {
    const res = await app.request(`/api/data/${COLL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
  };

  beforeAll(async () => {
    _setCacheForTests(new FakeRedis() as unknown as Redis);
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, { name: COLL, fields } as never);
    await write('predecessor');
    await Bun.sleep(5);
    asOf = new Date().toISOString();
    await Bun.sleep(5);
  }, 60_000);

  afterAll(async () => {
    _setCacheForTests(null);
    if (!db) return;
    await sql`DELETE FROM zv_revisions WHERE collection = ${COLL}`.execute(db).catch(() => {});
    await DDLManager.dropCollection(db, COLL, { force: true }).catch(() => {});
  });

  it('a re-created collection does not answer with its predecessor total', async () => {
    expect(await total()).toBe(1);
    await DDLManager.dropCollection(db, COLL, { force: true });
    await DDLManager.createCollection(db, { name: COLL, fields } as never);
    await write('successor');
    // `asOf` is before the new create, so the new collection had no record then.
    expect(await total()).toBe(0);
  }, 60_000);
});
