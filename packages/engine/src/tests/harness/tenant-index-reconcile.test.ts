/**
 * The composite tenant indexes are built after listen, CONCURRENTLY, by one
 * instance — not by the boot reconciler before the server serves.
 *
 * `reconcileTenantRLS` ran a plain CREATE INDEX for `(tenant_id, created_at)`
 * and `(tenant_id, updated_at, id)` on every collection table missing them,
 * before `Bun.serve`: on a large table that blocks its writers for the build
 * (about 0.6 µs a row) while nothing is served.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  applyTenantRLS,
  reconcileTenantIndexes,
  reconcileTenantRLS,
} from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}`.slice(-9);
const NAME = `tir_${TAG}`;
const TABLE = `zvd_${NAME}`;
const CREATED = `idx_${TABLE}_tenant_created`;
const UPDATED = `idx_${TABLE}_tenant_updated`;

d('tenant composite indexes after listen', () => {
  let db: Database;

  const indexes = async () =>
    (
      await sql<{ name: string; valid: boolean }>`
        SELECT c.relname AS name, i.indisvalid AS valid
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = to_regclass(${TABLE})
           AND c.relname IN (${CREATED}, ${UPDATED})
         ORDER BY 1`.execute(db)
    ).rows;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`CREATE TABLE ${sql.id(TABLE)} (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                title text,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now())`.execute(db);
    await sql`INSERT INTO ${sql.id(TABLE)} (title) SELECT 'r' || g FROM generate_series(1, 2000) g`.execute(
      db,
    );
    await sql`INSERT INTO zvd_collections (name, display_name, fields)
              VALUES (${NAME}, ${NAME}, '[]'::jsonb)`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_collections WHERE name = ${NAME}`.execute(db);
    await sql`DROP TABLE IF EXISTS ${sql.id(TABLE)}`.execute(db);
  });

  it('the boot reconciler isolates the table and leaves the composites to after listen', async () => {
    await reconcileTenantRLS(db);
    const policy = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_policy
       WHERE polrelid = to_regclass(${TABLE}) AND polname = 'tenant_isolation'`.execute(db);
    expect(policy.rows[0]!.n).toBe(1);
    expect(await indexes()).toEqual([]);
  });

  it('reconcileTenantIndexes builds both, valid', async () => {
    const r = await reconcileTenantIndexes(db);
    expect(r?.built).toEqual(expect.arrayContaining([CREATED, UPDATED]));
    expect(await indexes()).toEqual([
      { name: CREATED, valid: true },
      { name: UPDATED, valid: true },
    ]);
    // Settled: a second pass builds nothing.
    expect((await reconcileTenantIndexes(db))?.built).toEqual([]);
  });

  it('replaces an INVALID leftover of a build that died', async () => {
    await sql`DROP INDEX ${sql.id(CREATED)}`.execute(db);
    await sql`CREATE INDEX ${sql.id(CREATED)} ON ${sql.id(TABLE)} (tenant_id, created_at DESC)`.execute(
      db,
    );
    await sql`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass(${CREATED})`.execute(
      db,
    );
    expect((await indexes()).find((i) => i.name === CREATED)?.valid).toBe(false);
    const r = await reconcileTenantIndexes(db);
    expect(r?.built).toEqual([CREATED]);
    expect((await indexes()).find((i) => i.name === CREATED)?.valid).toBe(true);
  });

  it('two instances booting together build each index once', async () => {
    await sql`DROP INDEX ${sql.id(UPDATED)}`.execute(db);
    const [a, b] = await Promise.all([reconcileTenantIndexes(db), reconcileTenantIndexes(db)]);
    const ran = [a, b].filter((r) => r !== null);
    const built = ran.flatMap((r) => r!.built);
    expect(built.filter((n) => n === UPDATED)).toHaveLength(1);
  });

  it('a new collection still gets its indexes at once (an empty table costs nothing)', async () => {
    await sql`DROP INDEX ${sql.id(CREATED)}`.execute(db);
    await applyTenantRLS(db, TABLE);
    expect((await indexes()).map((i) => i.name)).toEqual([CREATED, UPDATED]);
  });
});
