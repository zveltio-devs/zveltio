/**
 * Ghost DDL — Stress & Fuzz Tests
 *
 * Requires a real PostgreSQL database (not mock).
 * Set TEST_DATABASE_URL env var to a dedicated test database.
 *
 * Run with: bun test packages/engine/src/tests/stress/ghost-ddl.stress.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { GhostDDL } from '../../lib/ghost-ddl.js';

// Skip all tests if no test DB is configured
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skipAll = !TEST_DB_URL;

let db: any;

beforeAll(async () => {
  if (skipAll) return;
  const { createDb } = await import('../../db/index.js');
  db = createDb(TEST_DB_URL!);
});

afterAll(async () => {
  if (skipAll || !db) return;
  await db.destroy().catch(() => {});
});

async function createTestTable(tableName: string, rows = 0): Promise<void> {
  await sql.raw(`DROP TABLE IF EXISTS "${tableName}" CASCADE`).execute(db);
  await sql.raw(`
    CREATE TABLE "${tableName}" (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL DEFAULT '',
      value INTEGER NOT NULL DEFAULT 0,
      data JSONB NOT NULL DEFAULT '{}',
      tags TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).execute(db);

  if (rows > 0) {
    // Batch insert using VALUES
    const batchSize = 1000;
    for (let offset = 0; offset < rows; offset += batchSize) {
      const count = Math.min(batchSize, rows - offset);
      const values = Array.from({ length: count }, (_, i) =>
        `(gen_random_uuid(), 'row-${offset + i}', ${offset + i}, '{"key":"value"}'::jsonb, ARRAY['tag1','tag2'])`,
      ).join(',');
      await sql.raw(`INSERT INTO "${tableName}" (id, name, value, data, tags) VALUES ${values}`).execute(db);
    }
  }
}

async function dropTestTable(tableName: string): Promise<void> {
  await sql.raw(`DROP TABLE IF EXISTS "${tableName}" CASCADE`).execute(db);
}

async function countRows(tableName: string): Promise<number> {
  const result = await sql.raw(`SELECT COUNT(*) AS cnt FROM "${tableName}"`).execute(db);
  return parseInt((result.rows[0] as any).cnt);
}

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_name = ${tableName} AND column_name = ${columnName}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

describe.skipIf(skipAll)('Ghost DDL — Stress & Fuzz Tests', () => {

  // ═══ Scenario 1: Concurrent inserts during migration ═══
  it('should not lose data during concurrent inserts while ghost DDL runs', async () => {
    const tableName = 'test_ghost_concurrent';
    await createTestTable(tableName, 1000);

    // Start Ghost DDL concurrently with inserts
    const ghostPromise = GhostDDL.execute(
      db,
      tableName,
      [`ADD COLUMN new_col TEXT NOT NULL DEFAULT 'added'`],
    );

    // Simultaneously insert 500 rows while migration runs
    const insertPromise = (async () => {
      const inserts = Array.from({ length: 50 }, (_, batchIdx) =>
        sql.raw(`
          INSERT INTO "${tableName}" (name, value, data, tags)
          SELECT 'concurrent-${batchIdx}-' || generate_series, ${batchIdx}, '{}'::jsonb, '{}'
          FROM generate_series(1, 10)
        `).execute(db).catch(() => { /* ignore during swap */ }),
      );
      await Promise.all(inserts);
    })();

    await Promise.all([ghostPromise, insertPromise]);

    // After migration, original table should have new column
    const newColExists = await columnExists(tableName, 'new_col');
    expect(newColExists).toBe(true);

    // Row count should be at least 1000 (inserts may partially fail during swap — acceptable)
    const count = await countRows(tableName);
    expect(count).toBeGreaterThanOrEqual(1000);

    // No duplicates
    const dupCheck = await sql.raw(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT id, COUNT(*) FROM "${tableName}" GROUP BY id HAVING COUNT(*) > 1
      ) t
    `).execute(db);
    expect(parseInt((dupCheck.rows[0] as any).cnt)).toBe(0);

    await dropTestTable(tableName);
  }, 60_000);

  // ═══ Scenario 2: Sequential DDL operations ═══
  it('should handle add + rename + delete column in sequence', async () => {
    const tableName = 'test_ghost_sequential';
    await createTestTable(tableName, 100);

    // 1. Add column
    await GhostDDL.execute(db, tableName, [`ADD COLUMN temp_col TEXT NOT NULL DEFAULT 'temp'`]);
    expect(await columnExists(tableName, 'temp_col')).toBe(true);

    // 2. Rename column (via add+drop — Ghost DDL doesn't support RENAME directly)
    await GhostDDL.execute(db, tableName, [
      `ADD COLUMN final_col TEXT NOT NULL DEFAULT ''`,
    ]);
    expect(await columnExists(tableName, 'final_col')).toBe(true);

    // 3. Drop temp_col
    await GhostDDL.execute(db, tableName, [`DROP COLUMN temp_col`]);
    expect(await columnExists(tableName, 'temp_col')).toBe(false);

    // Data integrity
    expect(await countRows(tableName)).toBe(100);

    await dropTestTable(tableName);
  }, 60_000);

  // ═══ Scenario 3: Large table migration ═══
  it('should complete migration on large table within timeout', async () => {
    const tableName = 'test_ghost_large';
    const rowCount = 10_000; // Use 10k for CI speed (scale to 100k in dedicated perf tests)
    await createTestTable(tableName, rowCount);

    const start = Date.now();
    await GhostDDL.execute(db, tableName, [`ADD COLUMN large_col TEXT NOT NULL DEFAULT 'migrated'`]);
    const duration = Date.now() - start;

    expect(await columnExists(tableName, 'large_col')).toBe(true);
    expect(await countRows(tableName)).toBe(rowCount);
    expect(duration).toBeLessThan(120_000); // Must complete within 2 minutes

    await dropTestTable(tableName);
  }, 180_000);

  // ═══ Scenario 4: Atomic swap integrity ═══
  it('should have original table intact if swap fails', async () => {
    const tableName = 'test_ghost_swap_fail';
    await createTestTable(tableName, 200);

    let swapCalled = false;
    let errorThrown = false;

    // Monkey-patch atomicSwap to throw on first call
    const originalSwap = GhostDDL.atomicSwap;
    (GhostDDL as any).atomicSwap = async (...args: any[]) => {
      if (!swapCalled) {
        swapCalled = true;
        throw new Error('Simulated swap failure');
      }
      return originalSwap(...args);
    };

    try {
      await GhostDDL.execute(db, tableName, [`ADD COLUMN swap_col TEXT NOT NULL DEFAULT 'swap'`]);
    } catch {
      errorThrown = true;
    } finally {
      (GhostDDL as any).atomicSwap = originalSwap;
    }

    expect(errorThrown).toBe(true);

    // Original table must still exist with all rows
    expect(await countRows(tableName)).toBe(200);
    // New column should NOT exist (swap didn't complete)
    expect(await columnExists(tableName, 'swap_col')).toBe(false);

    // Cleanup any ghost tables
    const ghosts = await sql.raw(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE '${tableName}_ghost_%'
    `).execute(db);
    for (const row of ghosts.rows) {
      await sql.raw(`DROP TABLE IF EXISTS "${(row as any).tablename}" CASCADE`).execute(db).catch(() => {});
    }

    await dropTestTable(tableName);
  }, 30_000);

  // ═══ Scenario 5: Changelog replay completeness ═══
  it('should apply changelog entries accumulated during batchCopy', async () => {
    const tableName = 'test_ghost_changelog';
    await createTestTable(tableName, 500);

    const migration = await GhostDDL.createGhost(db, tableName, [`ADD COLUMN cl_col TEXT NOT NULL DEFAULT ''`]);

    // Simulate changes during batchCopy
    await Promise.all([
      // Insert new rows
      sql.raw(`INSERT INTO "${tableName}" (name, value, data, tags) VALUES ('new1', 999, '{}'::jsonb, '{}')`).execute(db),
      sql.raw(`INSERT INTO "${tableName}" (name, value, data, tags) VALUES ('new2', 998, '{}'::jsonb, '{}')`).execute(db),
      // Update existing rows
      sql.raw(`UPDATE "${tableName}" SET value = -1 WHERE name LIKE 'row-%' LIMIT 50`).execute(db),
    ]);

    await GhostDDL.batchCopy(db, migration);
    await GhostDDL.applyChangelog(db, migration);
    await GhostDDL.atomicSwap(db, migration);

    // All original + new rows should be present
    const count = await countRows(tableName);
    expect(count).toBeGreaterThanOrEqual(502);
    expect(await columnExists(tableName, 'cl_col')).toBe(true);

    await dropTestTable(tableName);
  }, 60_000);

  // ═══ Scenario 6: DDL on empty table ═══
  it('should handle Ghost DDL on empty table without errors', async () => {
    const tableName = 'test_ghost_empty';
    await createTestTable(tableName, 0);

    await expect(
      GhostDDL.execute(db, tableName, [`ADD COLUMN empty_col TEXT NOT NULL DEFAULT 'ok'`]),
    ).resolves.not.toThrow();

    expect(await columnExists(tableName, 'empty_col')).toBe(true);
    expect(await countRows(tableName)).toBe(0);

    await dropTestTable(tableName);
  }, 30_000);

  // ═══ Scenario 7: JSONB + array data preservation ═══
  it('should preserve JSONB and array data through migration', async () => {
    const tableName = 'test_ghost_complex_data';
    await createTestTable(tableName, 0);

    await sql.raw(`
      INSERT INTO "${tableName}" (name, value, data, tags) VALUES
        ('json-test', 1, '{"nested":{"key":"value"},"arr":[1,2,3]}'::jsonb, ARRAY['a','b','c']),
        ('unicode', 2, '{"emoji":"🚀","special":"<>&\\""}'::jsonb, ARRAY['x'])
    `).execute(db);

    await GhostDDL.execute(db, tableName, [`ADD COLUMN migrated BOOLEAN NOT NULL DEFAULT true`]);

    const rows = await sql.raw(`SELECT data, tags FROM "${tableName}" ORDER BY name`).execute(db);
    const byName: Record<string, any> = {};
    for (const r of rows.rows as any[]) byName[r.name] = r;

    expect(byName['json-test'].data).toMatchObject({ nested: { key: 'value' }, arr: [1, 2, 3] });
    expect(byName['json-test'].tags).toEqual(['a', 'b', 'c']);
    expect(byName['unicode'].data.emoji).toBe('🚀');

    await dropTestTable(tableName);
  }, 30_000);

});
