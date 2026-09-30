/**
 * A ghost migration moves each value into the column that now holds it.
 *
 * The copy was `INSERT INTO ghost SELECT * FROM original` — by POSITION — and the
 * changelog replay keyed its upsert on the original's column names. So a DROP
 * COLUMN failed the copy outright ("INSERT has more expressions than target
 * columns"), which is every `remove_field` a schema-branch merge sends on a
 * table past 100 000 rows, and a RENAME COLUMN failed the replay of any write
 * that landed during the copy.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  cancelPendingCleanups,
  DDLManager,
  GhostDDL,
  sweepGhostOrphans,
} from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const STEPS = `hgm_${SFX}`;
const ROUTE = `hgm_route_${SFX}`;
const text = (name: string) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
});

async function columns(db: Database, table: string): Promise<string[]> {
  const r = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table}
      AND column_name IN ('a', 'b', 'c', 'c2')
    ORDER BY ordinal_position
  `.execute(db);
  return r.rows.map((x) => x.column_name);
}

d('ghost DDL column mapping', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    for (const name of [STEPS, ROUTE]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [text('a'), text('b'), text('c')],
      } as never);
    }
  });

  afterAll(async () => {
    if (!db) return;
    cancelPendingCleanups();
    for (const name of [STEPS, ROUTE]) {
      await sql`DROP TABLE IF EXISTS ${sql.id(`zvd_${name}`)} CASCADE`.execute(db).catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', name)
        .execute()
        .catch(() => {});
    }
    await sweepGhostOrphans(db);
  });

  it('a mid-table DROP and a RENAME carry the copy and the writes made during it', async () => {
    const table = `zvd_${STEPS}`;
    await sql`
      INSERT INTO ${sql.id(table)} (a, b, c) VALUES ('k1', 'b1', 'c1'), ('k2', 'b2', 'c2'), ('k3', 'b3', 'c3')
    `.execute(db);

    const migration = await GhostDDL.createGhost(db, table, [
      'DROP COLUMN b',
      'RENAME COLUMN c TO c2',
    ]);
    // Writes after the capture trigger exists: they reach the ghost only through
    // the changelog, keyed by the ORIGINAL column names.
    await sql`INSERT INTO ${sql.id(table)} (a, b, c) VALUES ('k4', 'b4', 'c4')`.execute(db);
    await sql`UPDATE ${sql.id(table)} SET c = 'c1-updated' WHERE a = 'k1'`.execute(db);
    await sql`DELETE FROM ${sql.id(table)} WHERE a = 'k2'`.execute(db);

    await GhostDDL.batchCopy(db, migration);
    await GhostDDL.applyChangelog(db, migration);
    await GhostDDL.atomicSwap(db, migration);

    expect(await columns(db, table)).toEqual(['a', 'c2']);
    const rows = await sql<{ a: string; c2: string }>`
      SELECT a, c2 FROM ${sql.id(table)} ORDER BY a
    `.execute(db);
    expect(rows.rows).toEqual([
      { a: 'k1', c2: 'c1-updated' },
      { a: 'k3', c2: 'c3' },
      { a: 'k4', c2: 'c4' },
    ]);
  });

  it('remove_field through a schema-branch merge past 100 000 rows', async () => {
    const table = `zvd_${ROUTE}`;
    await sql`
      INSERT INTO ${sql.id(table)} (a, b, c)
      SELECT 'a' || g, 'b' || g, 'c' || g FROM generate_series(1, 100001) g
    `.execute(db);

    const created = await app.request('/api/schema/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `hgm-${SFX}` }),
    });
    const { branch, schema } = (await created.json()) as { branch: { id: string }; schema: string };
    await app.request(`/api/schema/branches/${branch.id}/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ type: 'remove_field', payload: { collection: ROUTE, field: 'b' } }),
    });
    const res = await app.request(`/api/schema/branches/${branch.id}/merge`, {
      method: 'POST',
      headers: { cookie },
    });
    const body = (await res.json()) as { errors: string[] };
    await db.deleteFrom('zv_schema_branches').where('id', '=', branch.id).execute();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);

    expect(body.errors).toEqual([]);
    expect(await columns(db, table)).toEqual(['a', 'c']);
    const sample = await sql<{ n: number; ok: number }>`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE c = 'c' || substr(a, 2))::int AS ok
      FROM ${sql.id(table)}
    `.execute(db);
    expect(sample.rows[0]).toEqual({ n: 100001, ok: 100001 });
  }, 120_000);
});
