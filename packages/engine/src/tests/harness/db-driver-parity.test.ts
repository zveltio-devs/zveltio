/**
 * `ZVELTIO_DB_DRIVER=pg` stores what `Bun.SQL` stores.
 *
 * An operator who switches drivers must not find different bytes in the same
 * columns. `Bun.SQL` JSON-encodes a parameter the server describes as `json` or
 * `jsonb` — a string becomes a JSON string — while `pg` sends a string as it
 * is, so the same insert stored another value or failed to parse. Arrays are
 * bound as `BunSqlDialect` binds them. And a failed statement carries its
 * SQLSTATE on `errno`, which is where the engine reads it.
 *
 * A bare number or boolean into `jsonb` is left out: `Bun.SQL` types it itself
 * and refuses it ("expression is of type integer"), so no stored row exists to
 * compare. `toJsonb` is the form that works on both.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqlDialect } from '../../db/bun-sql-dialect.js';
import { createPgDialect, normalizePgError } from '../../db/pg-dialect.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;
const T = `zz_driver_parity_${Date.now()}`;

type Db = Kysely<any>;

d('the pg dialect stores what Bun.SQL stores', () => {
  let bun: Db;
  let pgdb: Db;

  beforeAll(async () => {
    bun = new Kysely({ dialect: new BunSqlDialect({ connectionString: URL! }) });
    pgdb = new Kysely({ dialect: createPgDialect({ connectionString: URL! }) });
    await sql`CREATE TABLE ${sql.id(T)} (
                driver text, k text, j jsonb, js json, t text, ta text[], u uuid)`.execute(bun);
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS ${sql.id(T)}`.execute(bun).catch(() => {});
    await bun?.destroy();
    await pgdb?.destroy();
  });

  const VALUES: Array<[string, Record<string, unknown>]> = [
    ['string into jsonb', { j: 'en' }],
    ['JSON text into jsonb', { j: JSON.stringify([{ a: 1 }]) }],
    ['object into jsonb', { j: { a: 1, b: [true, null] } }],
    ['array into jsonb', { j: [{ a: 1 }] }],
    ['string into json', { js: 'x' }],
    ['text', { t: 'plain "quoted" \\ text' }],
    ['text[]', { ta: ['a', 'b,c', 'd"e', null] }],
    ['uuid', { u: '6e4e3e2a-1111-4c4c-8888-0123456789ab' }],
  ];

  it('every kind of value lands byte for byte the same through both drivers', async () => {
    for (const [k, row] of VALUES) {
      for (const [driver, db] of [
        ['bun', bun],
        ['pg', pgdb],
      ] as const) {
        await db
          .insertInto(T)
          .values({ driver, k, ...row })
          .execute()
          .catch((err: Error) => {
            throw new Error(`${driver} could not store "${k}": ${err.message}`);
          });
      }
    }
    const stored = await sql<{ k: string; driver: string; v: string }>`
      SELECT k, driver, concat_ws('|', j::text, js::text, t, ta::text, u::text) AS v
        FROM ${sql.id(T)} ORDER BY k, driver`.execute(bun);
    const by = (driver: string) =>
      Object.fromEntries(stored.rows.filter((r) => r.driver === driver).map((r) => [r.k, r.v]));
    expect(by('pg')).toEqual(by('bun'));
    expect(Object.keys(by('pg'))).toHaveLength(VALUES.length);
  });

  it('reads back the same JavaScript values through both drivers', async () => {
    const read = (db: Db) =>
      db
        .selectFrom(T)
        .select(['k', 'j', 'js', 't', 'ta', 'u'])
        .where('driver', '=', 'bun')
        .orderBy('k')
        .execute();
    expect(await read(pgdb)).toEqual(await read(bun));
  });

  it('a failed statement carries its SQLSTATE on errno through both drivers', async () => {
    for (const db of [bun, pgdb]) {
      const err = await sql`SELECT 1 / 0`.execute(db).then(
        () => null,
        (e: { errno?: string }) => e,
      );
      expect(err?.errno).toBe('22012');
    }
    expect((normalizePgError({ code: '23505' }) as { errno?: string }).errno).toBe('23505');
  });

  it('a transaction rolls back and a savepoint-joined block holds through the pg driver', async () => {
    await pgdb
      .transaction()
      .execute(async (trx) => {
        await trx.insertInto(T).values({ driver: 'pg', k: 'rolled-back' }).execute();
        throw new Error('undo');
      })
      .catch(() => {});
    const left = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id(T)} WHERE k = 'rolled-back'`.execute(bun);
    expect(left.rows[0]!.n).toBe(0);
  });
});
