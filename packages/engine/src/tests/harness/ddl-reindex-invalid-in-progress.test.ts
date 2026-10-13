/**
 * reindexInvalid at boot must leave alone an index another replica is still
 * building: CREATE INDEX CONCURRENTLY shows it as INVALID until it finishes,
 * and a REINDEX there waits on (and races) that build.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import { sql } from 'kysely';
import { _internalForTests } from '../../lib/data/ddl-queue.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const T = `zvd_reidx_${Date.now()}`;
const IDX = `${T}_v`;

d('reindexInvalid skips an index still being built', () => {
  const url = process.env.TEST_DATABASE_URL!;
  const holder = new SQL(url, { max: 1 });
  const builder = new SQL(url, { max: 1 });

  afterAll(async () => {
    await holder.close();
    await builder.close();
    const { db } = await getTestApp();
    await sql.raw(`DROP TABLE IF EXISTS "${T}"`).execute(db);
  });

  it('returns without touching it', async () => {
    const { db } = await getTestApp();
    await sql.raw(`CREATE TABLE "${T}" (v int)`).execute(db);
    // An open writer keeps the concurrent build waiting, its index INVALID.
    const tx = await holder.reserve();
    await tx`BEGIN`;
    await tx.unsafe(`INSERT INTO "${T}" VALUES (1)`);
    // Bun's SQL sends nothing until the query is awaited or then'd.
    const build = builder.unsafe(`CREATE INDEX CONCURRENTLY "${IDX}" ON "${T}" (v)`).then(
      () => 'built',
      (e: Error) => e.message,
    );
    for (let i = 0; i < 50; i++) {
      const r = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_progress_create_index p
          JOIN pg_class c ON c.oid = p.index_relid WHERE c.relname = ${IDX}`.execute(db);
      if (r.rows[0]?.n) break;
      await Bun.sleep(100);
    }

    const outcome = await Promise.race([
      _internalForTests.reindexInvalid(db).then(() => 'returned'),
      Bun.sleep(3000).then(() => 'blocked'),
    ]);
    await tx`ROLLBACK`;
    tx.release();
    expect(outcome).toBe('returned');
    // And the build it left alone finishes (a REINDEX here deadlocked it).
    expect(await build).toBe('built');
  });
});
