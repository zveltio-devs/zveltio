/**
 * A `unique` field added to a table with rows builds its key outside the
 * table's exclusive lock (DR-37).
 *
 * `addField` ran `ADD COLUMN` and `ADD UNIQUE (tenant_id, <field>)` in one
 * transaction, so the key's index was built over every row while readers and
 * writers waited: 452 ms at 1,000,000 rows. The column is now added on its
 * own, the index is built `CONCURRENTLY`, then attached as the constraint.
 *
 * Proof that the build is concurrent, without timing: a `CREATE INDEX
 * CONCURRENTLY` waits for every transaction older than it, so an open
 * REPEATABLE READ transaction holds the build in progress. While it is held,
 * the table must take a write. A build under the lock never waits on it.
 *
 * And a key the rows already break (a constant default over many rows, or a
 * column that already held repeats) refuses the add with nothing left: no
 * INVALID index, no constraint, no metadata, and no column the add created.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  asTenant,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const SFX = Date.now();
const C = `auf_${SFX}`;
const TABLE = `zvd_${C}`;
const ROWS = 2000;

const text = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
  ...over,
});

d('a unique field is added without building its key under the lock', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const addByRoute = async (field: Record<string, unknown>) => {
    const res = await app.request(`/api/collections/${C}/fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(field),
    });
    return { status: res.status, body: await res.text() };
  };

  /** Each index on the table, with whether it is valid and the constraint on it. */
  const indexes = async () =>
    (
      await sql<{ name: string; valid: boolean; con: string | null; def: string }>`
        SELECT ix.relname AS name, i.indisvalid AS valid, k.contype::text AS con,
               pg_get_indexdef(i.indexrelid) AS def
          FROM pg_index i JOIN pg_class ix ON ix.oid = i.indexrelid
          LEFT JOIN pg_constraint k ON k.conindid = i.indexrelid AND k.conrelid = i.indrelid
         WHERE i.indrelid = ${TABLE}::regclass`.execute(db)
    ).rows;

  const hasColumn = async (col: string) =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_attribute
         WHERE attrelid = ${TABLE}::regclass AND attname = ${col} AND NOT attisdropped`.execute(db)
    ).rows[0]!.n === 1;

  const fieldNames = async () =>
    ((await DDLManager.getCollection(db, C))?.fields as { name: string }[]).map((f) => f.name);

  /**
   * Run `add` while an older transaction holds a snapshot. A CONCURRENTLY build
   * of the key waits for it; once one is seen waiting, `write` must go through.
   */
  const addWhileHeld = async (column: string, add: () => Promise<unknown>) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let opened!: () => void;
    const open = new Promise<void>((r) => {
      opened = r;
    });
    const holder = db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        await sql`SELECT 1`.execute(trx);
        opened();
        await gate;
      });
    await open;
    const adding = add();
    try {
      let building = false;
      for (let i = 0; i < 200 && !building; i++) {
        const r = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND state = 'active'
             AND query ILIKE ${`%CREATE UNIQUE INDEX CONCURRENTLY%${TABLE}%`}`.execute(db);
        building = r.rows[0]!.n > 0;
        if (!building) await Bun.sleep(25);
      }
      expect(building, 'the key was never built CONCURRENTLY').toBe(true);
      // The build is in progress: the table takes a write, at once.
      await asTenant(db, TENANT, async (trx) => {
        await sql`SET LOCAL lock_timeout = '1s'`.execute(trx);
        await sql`INSERT INTO ${sql.id(TABLE)} (${sql.id(column)}) VALUES ('during')`.execute(trx);
      });
    } finally {
      release();
      await holder;
    }
    return adding;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, { name: C, fields: [text('label')] } as never);
    await asTenant(db, TENANT, (trx) =>
      sql`INSERT INTO ${sql.id(TABLE)} (label) SELECT 'r' || g FROM generate_series(1, ${ROWS}) g`.execute(
        trx,
      ),
    );
  }, 60_000);

  afterAll(async () => {
    if (db) await dropTestCollection(db, C);
  });

  it('addField: the key is built CONCURRENTLY while the table takes writes', async () => {
    await addWhileHeld('label', () => DDLManager.addField(db, C, text('code', { unique: true })));
    const key = (await indexes()).filter((i) => /\(tenant_id, code\)/.test(i.def));
    expect(key).toEqual([expect.objectContaining({ valid: true, con: 'u' })]);
    expect(await fieldNames()).toContain('code');
  }, 30_000);

  it('the add-field route: the same', async () => {
    let res: { status: number; body: string } | undefined;
    await addWhileHeld('label', async () => {
      res = await addByRoute(text('sku', { unique: true }));
    });
    expect(res!.status, res!.body).toBeLessThan(300);
    const key = (await indexes()).filter((i) => /\(tenant_id, sku\)/.test(i.def));
    expect(key).toEqual([expect.objectContaining({ valid: true, con: 'u' })]);
    expect(await fieldNames()).toContain('sku');
  }, 30_000);

  it('the key is enforced per tenant', async () => {
    const put = (v: string) =>
      asTenant(db, TENANT, (trx) =>
        sql`INSERT INTO ${sql.id(TABLE)} (code) VALUES (${v})`.execute(trx),
      ).then(
        () => 'ok',
        (e: { errno?: string }) => String(e.errno),
      );
    expect(await put('K-1')).toBe('ok');
    expect(await put('K-1')).toBe('23505');
  });

  it('rows that break the key refuse the add, and nothing is left', async () => {
    // A constant default gives every existing row the same value.
    const before = await indexes();
    await expect(
      DDLManager.addField(db, C, text('grade', { unique: true, defaultValue: 'A' })),
    ).rejects.toMatchObject({ errno: '23505' });
    expect(await hasColumn('grade')).toBe(false);
    expect(await indexes()).toEqual(before);
    expect(await fieldNames()).not.toContain('grade');

    const res = await addByRoute(text('tier', { unique: true, defaultValue: 'B' }));
    expect(res.status).toBe(400);
    expect(await hasColumn('tier')).toBe(false);
    expect(await indexes()).toEqual(before);
    expect(await fieldNames()).not.toContain('tier');
  }, 30_000);

  it('a column the add did not create is kept, with its rows', async () => {
    // Already there, outside the metadata: the add adopts it, and it repeats values.
    await sql`ALTER TABLE ${sql.id(TABLE)} ADD COLUMN legacy text`.execute(db);
    await asTenant(db, TENANT, (trx) =>
      sql`UPDATE ${sql.id(TABLE)} SET legacy = 'same' WHERE label IN ('r1', 'r2')`.execute(trx),
    );
    const before = await indexes();
    await expect(
      DDLManager.addField(db, C, text('legacy', { unique: true })),
    ).rejects.toMatchObject({ errno: '23505' });
    expect(await hasColumn('legacy')).toBe(true);
    const kept = await asTenant(db, TENANT, (trx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.id(TABLE)} WHERE legacy = 'same'`.execute(
        trx,
      ),
    );
    expect(kept.rows[0]!.n).toBe(2);
    expect(await indexes()).toEqual(before);
    expect(await fieldNames()).not.toContain('legacy');
  }, 30_000);
});
