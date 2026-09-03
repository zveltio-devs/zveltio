/**
 * `toJsonb` puts the VALUE in a jsonb column, not a string containing it.
 *
 * This runs against a real column because that is the only place the question is
 * decided: every wrong form here is wrong inside the driver, not inside our
 * code, so a mock would agree with whatever we assumed. Four writers had already
 * assumed wrong — measured on a live instance, `zv_api_keys.scopes` was a jsonb
 * string in 15 of 15 rows, `zv_license_audit.details` 112 of 112,
 * `zv_notifications.metadata` 22 of 22.
 *
 * The three wrong forms are pinned alongside the right one, because each is a
 * plausible repair and two of them look correct until you query the column.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { toJsonb } from '../../lib/jsonb.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const T = `zz_jsonb_${Date.now()}`;

d('toJsonb — what actually lands in a jsonb column', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql.raw(`CREATE TABLE IF NOT EXISTS "${T}" (k text primary key, v jsonb)`).execute(db);
  });

  afterAll(async () => {
    if (db)
      await sql
        .raw(`DROP TABLE IF EXISTS "${T}"`)
        .execute(db)
        .catch(() => {});
  });

  const store = async (k: string, expr: unknown) => {
    await sql`INSERT INTO ${sql.id(T)} (k, v) VALUES (${k}, ${expr})`.execute(db);
    const r = await sql<{ t: string | null }>`
      SELECT jsonb_typeof(v) AS t FROM ${sql.id(T)} WHERE k = ${k}
    `.execute(db);
    return r.rows[0]!.t;
  };

  it('preserves every JSON type, including the array form the raw value breaks', async () => {
    expect(await store('object', toJsonb({ a: 1 }))).toBe('object');
    expect(await store('array', toJsonb([{ collection: 'c', actions: ['read'] }]))).toBe('array');
    expect(await store('empty-array', toJsonb([]))).toBe('array');
    expect(await store('string', toJsonb('en'))).toBe('string');
    expect(await store('number', toJsonb(42))).toBe('number');
    expect(await store('bool', toJsonb(false))).toBe('boolean');
    expect(await store('null', toJsonb(null))).toBe('null');
  });

  it('keeps an array queryable by containment, which is what the defect cost', async () => {
    // `scopes @> '[…]'` answering false for a key that HAS the scope is the
    // shape of this bug that would matter most: an authorization check written
    // the natural SQL way would deny a key its own permissions.
    await sql`INSERT INTO ${sql.id(T)} (k, v) VALUES ('scopes', ${toJsonb([
      { collection: 'c', actions: ['read'] },
    ])})`.execute(db);

    const hit = await sql<{ ok: boolean }>`
      SELECT (v @> '[{"collection":"c"}]'::jsonb) AS ok FROM ${sql.id(T)} WHERE k = 'scopes'
    `.execute(db);
    expect(hit.rows[0]!.ok).toBe(true);
  });

  it('pins the three wrong forms, because two of them look like the fix', async () => {
    const arr = [{ a: 1 }];

    // What the four broken writers did: a string parameter is stored as a jsonb
    // STRING holding JSON text.
    expect(await store('w-stringify', JSON.stringify(arr))).toBe('string');

    // The obvious repair, and a trap: the driver has already encoded the
    // parameter as JSON, so this casts a jsonb string to a jsonb string.
    expect(await store('w-cast', sql`${JSON.stringify(arr)}::jsonb`)).toBe('string');

    // "Pass the raw value" — right for an object, and silently destructive for
    // an array: the driver renders it as a Postgres array literal, so `[{a:1}]`
    // is stored as the string `{"[object Object]"}`.
    expect(await store('w-raw-array', arr)).toBe('string');
    const raw = await sql<{ v: string }>`
      SELECT v #>> '{}' AS v FROM ${sql.id(T)} WHERE k = 'w-raw-array'
    `.execute(db);
    expect(raw.rows[0]!.v).toContain('[object Object]');
  });
});
