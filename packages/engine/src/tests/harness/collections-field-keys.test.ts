/**
 * PATCH /api/collections/:name/fields/:field — unique, indexed, default_value
 * on a column that already holds rows.
 *
 * The refusals are checked by what did NOT change: a unique key over rows
 * that repeat a value is refused and leaves no INVALID index behind.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hfkeys_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;

d('collections field keys (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const patch = (field: string, body: unknown) =>
    app.request(`/api/collections/${COLLECTION}/fields/${field}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  const field = async (name: string) => {
    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    return fields.find((f: { name: string }) => f.name === name);
  };

  const indexes = async () =>
    (
      await sql<{ indexname: string; valid: boolean }>`
        SELECT i.indexname, x.indisvalid AS valid FROM pg_indexes i
          JOIN pg_index x ON x.indexrelid = to_regclass(quote_ident(i.indexname))
         WHERE i.tablename = ${TABLE} AND i.indexdef LIKE '%code%'`.execute(db)
    ).rows;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'code', type: 'text' },
        { name: 'owner', type: 'm2o', options: { related_collection: COLLECTION } },
      ],
    } as never);
    await sql`INSERT INTO ${sql.id(TABLE)} (code) VALUES ('a'), ('a'), ('b')`.execute(db);
  });

  afterAll(async () => {
    if (db) await dropTestCollection(db, COLLECTION);
  });

  it('refuses a unique key over repeated values and leaves no index behind', async () => {
    const res = await patch('code', { unique: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toContain('repeats a value');
    expect(await indexes()).toEqual([]);
    expect((await field('code')).unique).toBeFalsy();
  });

  it('adds and removes the unique key, the indexes and the default', async () => {
    await sql`DELETE FROM ${sql.id(TABLE)} WHERE code = 'a'`.execute(db);
    expect((await patch('code', { unique: true, indexed: true, default_value: 'x' })).status).toBe(
      200,
    );
    expect(await field('code')).toMatchObject({ unique: true, indexed: true, defaultValue: 'x' });
    expect((await indexes()).every((i) => i.valid)).toBe(true);
    // the unique key, the btree index and the tenant-first one
    expect((await indexes()).length).toBe(3);
    await expect(
      sql`INSERT INTO ${sql.id(TABLE)} (code) VALUES ('b')`.execute(db),
    ).rejects.toThrow();
    const ins = await sql<{ code: string }>`
      INSERT INTO ${sql.id(TABLE)} DEFAULT VALUES RETURNING code`.execute(db);
    expect(ins.rows[0].code).toBe('x');

    expect(
      (await patch('code', { unique: false, indexed: false, default_value: null })).status,
    ).toBe(200);
    const f = await field('code');
    expect(f.unique).toBe(false);
    expect(f.indexed).toBe(false);
    expect('defaultValue' in f).toBe(false);
    expect(await indexes()).toEqual([]);
    const bare = await sql<{ code: string | null }>`
      INSERT INTO ${sql.id(TABLE)} DEFAULT VALUES RETURNING code`.execute(db);
    expect(bare.rows[0].code).toBeNull();
  });

  it('refuses these keys on a relation field', async () => {
    const res = await patch('owner', { indexed: true });
    expect(res.status).toBe(400);
    expect((await field('owner')).indexed).toBeFalsy();
  });
});
