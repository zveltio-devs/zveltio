/**
 * Auto-run pending migrations on engine startup (S4-10).
 *
 * Wraps `runPending(db)` in an advisory lock (`withAdvisoryLock`) so multiple
 * engine replicas starting simultaneously can't race the migration runner.
 * Only one process holds the lock; the others wait, then re-check
 * `getLastAppliedMigration` and skip if everything is already applied.
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

import { withAdvisoryLock } from './advisory-lock.js';
import type { Database } from './index.js';
import { runPending, getLastAppliedMigration, assertChainCompatible } from './migrations/index.js';
import { MAX_SCHEMA_VERSION } from '../version.js';

/**
 * Stable 64-bit integer used as the advisory lock key — unchanged since the
 * session-lock version, so a replica still running that one excludes this one.
 * Computed once (hash of 'zveltio:migrations') so every replica converges on
 * the same value. PostgreSQL advisory locks live in a separate namespace from
 * row/table locks — they don't block reads/writes.
 *
 * To regenerate: `printf 'zveltio:migrations' | sha256sum` → first 16
 * hex chars → parse as signed bigint. We use a fixed literal so we
 * don't depend on a hashing roundtrip on every startup.
 */
const MIGRATIONS_LOCK_KEY = 0x7a76656c74696f00n; // 'zveltio\0' as bigint

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
  const before = await getLastAppliedMigration(db);

  // Before anything concludes there is nothing to do. The shortcut below
  // compares high-water marks, which is only meaningful while the chain grows
  // monotonically; a database whose chain was squashed away records a HIGHER
  // number than this build ships and would sail straight through it, applying
  // nothing and saying nothing. This compares identities instead.
  await assertChainCompatible(db);

  if (before >= MAX_SCHEMA_VERSION) {
    // Common case: replicas restarting against an up-to-date schema.
    // Skip the lock altogether so we don't add round-trips when there's
    // nothing to do.
    return { ran: false, before, after: before, durationMs: Date.now() - t0 };
  }

  console.log(`⚙️  Pending migrations: ${MAX_SCHEMA_VERSION - before}. Acquiring advisory lock…`);

  // Every replica waits here, then re-checks: the one ahead may have applied it all.
  return withAdvisoryLock(db, MIGRATIONS_LOCK_KEY, async () => {
    const recheck = await getLastAppliedMigration(db);
    if (recheck >= MAX_SCHEMA_VERSION) {
      console.log(`✅ Migrations applied by another replica while we waited (now at v${recheck})`);
      return { ran: false, before, after: recheck, durationMs: Date.now() - t0 };
    }

    await runPending(db);
    const after = await getLastAppliedMigration(db);
    const durationMs = Date.now() - t0;
    console.log(`✅ Auto-migrate complete: v${before} → v${after} (${durationMs}ms)`);
    return { ran: true, before, after, durationMs };
  });
}
