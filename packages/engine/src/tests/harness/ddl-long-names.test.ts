/**
 * Generated identifiers past Postgres' 63-byte limit (lib/pg-identifier.ts).
 *
 * Postgres truncates a long identifier with only a NOTICE. Every index on a
 * collection is `idx_<table>_<suffix>`, so past a 50-odd-character name they
 * all truncated to one and every `CREATE INDEX IF NOT EXISTS` after the first
 * built nothing: a 55-character collection had 2 of its indexes. Two m2m
 * junction tables whose names shared 63 characters were one table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { applyTenantRLS } from '../../lib/tenancy/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-6);
const SHORT = `hls_${SFX}`;
const LONG = `hll_${SFX}_${'x'.repeat(44)}`; // 55 characters
const SRC = `hlsrc_${SFX}_${'s'.repeat(18)}`;
const TGT_A = `hltgt_${SFX}_${'t'.repeat(18)}_a`;
const TGT_B = `hltgt_${SFX}_${'t'.repeat(18)}_b`;

const field = (name: string, type: string, extra: object = {}) => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
  ...extra,
});

d('generated names past 63 bytes (in-process)', () => {
  let db: Database;

  const indexes = async (c: string) => {
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = ${`zvd_${c}`}
    `.execute(db);
    return r.rows[0]?.n ?? 0;
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  afterAll(async () => {
    if (!db) return;
    for (const c of [SHORT, LONG, SRC, TGT_A, TGT_B]) {
      await dropTestCollection(db, c).catch(() => {});
    }
  });

  it('gives a long-named collection every index a short-named one gets', async () => {
    const fields = [
      field('title', 'text', { indexed: true }),
      field('total', 'integer', { indexed: true }),
    ];
    for (const name of [SHORT, LONG]) {
      await DDLManager.createCollection(db, { name, fields } as never);
      await applyTenantRLS(db, `zvd_${name}`);
    }
    expect(LONG.length).toBe(55);
    expect(await indexes(LONG)).toBe(await indexes(SHORT));
    expect(await indexes(SHORT)).toBeGreaterThanOrEqual(9);
  });

  it('gives two m2m relations with long names two junction tables', async () => {
    for (const name of [TGT_A, TGT_B]) {
      await DDLManager.createCollection(db, { name, fields: [field('label', 'text')] } as never);
    }
    await DDLManager.createCollection(db, {
      name: SRC,
      fields: [
        field('label', 'text'),
        field('to_a', 'm2m', { options: { related_collection: TGT_A } }),
        field('to_b', 'm2m', { options: { related_collection: TGT_B } }),
      ],
    } as never);
    const rels = await db
      .selectFrom('zvd_relations')
      .select('junction_table')
      .where('source_collection', '=', SRC)
      .where('type', '=', 'm2m')
      .execute();
    const tables = rels.map((r) => r.junction_table as string);
    expect(new Set(tables).size).toBe(2);
    for (const t of tables) {
      expect(t.length).toBeLessThanOrEqual(63);
      const cols = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns WHERE table_name = ${t}
      `.execute(db);
      expect(cols.rows.length).toBeGreaterThanOrEqual(3);
    }
  });
});
