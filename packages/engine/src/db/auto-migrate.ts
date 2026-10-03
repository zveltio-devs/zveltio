/**
 * Auto-run pending migrations on engine startup (S4-10).
 *
 * Wraps `runPending(db)` in the migration lock (`withMigrationLock`) so multiple
 * engine replicas starting simultaneously can't race the migration runner.
 * Only one process holds the lock; the others wait, then re-check
 * `pendingMigrations` and skip if everything is already applied.
 *
 * Opt out: `MIGRATIONS_AUTO=false` skips the entire flow (useful for
 * CI, debugging, or operators who prefer running `zveltio migrate`
 * explicitly).
 *
 * Failure mode: if migrations fail, the engine refuses to start —
 * better to surface the error at boot than to serve traffic against an
 * inconsistent schema. The previous behavior (warn-and-continue) was
 * the source of "extension X expected column Y, got null" production
 * bugs.
 */

import type { Database } from './index.js';
import {
  runPending,
  getLastAppliedMigration,
  pendingMigrations,
  withMigrationLock,
} from './migrations/index.js';

export interface AutoMigrateResult {
  /** True if the lock was acquired and (potentially) migrations ran. */
  ran: boolean;
  /** Schema version before this run. */
  before: number;
  /** Schema version after this run. */
  after: number;
  /** Total wall time in ms. */
  durationMs: number;
}

/**
 * Acquire the migration advisory lock, run pending migrations, release.
 *
 * Idempotent: if every migration is already applied, the lock is still
 * acquired briefly but no migrations execute. Multiple replicas race —
 * only one runs migrations, the others wait on the lock and then find
 * nothing pending.
 *
 * @throws if migrations fail. Engine startup should exit on failure.
 */
export async function autoMigrate(db: Database): Promise<AutoMigrateResult> {
  if (process.env.MIGRATIONS_AUTO === 'false') {
    const current = await getLastAppliedMigration(db);
    console.log(`⏭️  MIGRATIONS_AUTO=false — skipping auto-migrate (schema v${current})`);
    return { ran: false, before: current, after: current, durationMs: 0 };
  }

  const t0 = Date.now();

  // What is pending is a set difference, not "is the high-water mark below the
  // newest file". This used to return on `lastApplied >= MAX_SCHEMA_VERSION`,
  // which reads a database that recorded 048 before 047 was merged as up to
  // date — and 047 then never ran anywhere. The same read checks the recorded
  // chain against this build first (squash, edited file), and is the only
  // query when nothing is pending.
  const { lastApplied: before, pending } = await pendingMigrations(db);
  if (pending.length === 0) {
    // Common case: replicas restarting against an up-to-date schema.
    // Skip the lock altogether so we don't add round-trips when there's
    // nothing to do.
    return { ran: false, before, after: before, durationMs: Date.now() - t0 };
  }

  console.log(
    `⚙️  Pending migrations: ${pending.map((m) => m.filename).join(', ')}. Acquiring advisory lock…`,
  );

  // Every replica waits here, then re-checks: the one ahead may have applied it all.
  return withMigrationLock(db, async () => {
    const recheck = await pendingMigrations(db);
    if (recheck.pending.length === 0) {
      console.log(
        `✅ Migrations applied by another replica while we waited (now at v${recheck.lastApplied})`,
      );
      return { ran: false, before, after: recheck.lastApplied, durationMs: Date.now() - t0 };
    }

    const applied = await runPending(db);
    const after = await getLastAppliedMigration(db);
    const durationMs = Date.now() - t0;
    console.log(
      `✅ Auto-migrate complete: ${applied.length} applied, v${before} → v${after} (${durationMs}ms)`,
    );
    return { ran: true, before, after, durationMs };
  });
}
