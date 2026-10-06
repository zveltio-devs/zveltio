/**
 * Garbage Collector — applies log retention, purges old sync tombstones, and
 * fails flow runs abandoned in 'running'. Once per night, on one replica.
 *
 * It also swept every `tenant_%`/public table for a `_deletedAt` column. No
 * table has one — the engine's soft delete is `deleted_at`, purged by the
 * trash handler — so that sweep deleted nothing, ever, and was removed.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { tryAdvisoryLock } from '../../db/advisory-lock.js';
import { withEveryTenant } from '../tenancy/index.js';

const ABANDONED_RUN_HOURS = 6;

/**
 * How long sync pull remembers a deleted row. A client whose position is older
 * may have missed a purged tombstone, so pull answers it `resync`.
 */
export const SYNC_TOMBSTONE_RETENTION_DAYS = 30;

/**
 * A retention knob in whole days; 0 keeps forever. Anything else purges
 * nothing: `parseInt('1y')` is 1, so a value written as a duration purged every
 * row older than a day. Deleting on a value nobody meant is the one wrong way to
 * fail.
 */
function retentionDaysFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (/^\d+$/.test(raw)) return Number(raw);
  console.warn(
    `[GC] ${name}=${JSON.stringify(raw)} is not a whole number of days; nothing is purged.`,
  );
  return 0;
}

export async function runGarbageCollector(db: Database): Promise<void> {
  console.log('[GC] Starting garbage collection...');

  let totalDeleted = 0;

  // ── Retention purges for high-churn audit tables ──────────────────
  // zv_request_logs grows ~one row per API call — without a retention
  // sweep the table reaches hundreds of millions of rows on a busy
  // deployment and starts hurting writes. REQUEST_LOG_RETENTION_DAYS
  // controls the cutoff (default 30, set to 0 to keep forever).
  // Same shape extended to zv_slow_queries; both are observability
  // tables, not source of truth for anything.
  const retentionDays = retentionDaysFromEnv('REQUEST_LOG_RETENTION_DAYS', 30);
  if (retentionDays > 0) {
    try {
      const reqDeleted = await sql<{ deleted: number }>`
        WITH d AS (
          DELETE FROM zv_request_logs
          WHERE created_at < NOW() - (${retentionDays}::int || ' days')::interval
          RETURNING 1
        )
        SELECT COUNT(*)::int AS deleted FROM d
      `.execute(db);
      const n = reqDeleted.rows[0]?.deleted ?? 0;
      if (n > 0) {
        console.log(`[GC] zv_request_logs: ${n} rows older than ${retentionDays}d purged`);
        totalDeleted += n;
      }
    } catch (err) {
      console.warn('[GC] zv_request_logs purge failed:', (err as Error).message);
    }

    try {
      const slowDeleted = await sql<{ deleted: number }>`
        WITH d AS (
          DELETE FROM zv_slow_queries
          WHERE created_at < NOW() - (${retentionDays}::int || ' days')::interval
          RETURNING 1
        )
        SELECT COUNT(*)::int AS deleted FROM d
      `.execute(db);
      const n = slowDeleted.rows[0]?.deleted ?? 0;
      if (n > 0) {
        console.log(`[GC] zv_slow_queries: ${n} rows older than ${retentionDays}d purged`);
        totalDeleted += n;
      }
    } catch (err) {
      console.warn('[GC] zv_slow_queries purge failed:', (err as Error).message);
    }
  }

  // Audit log retention — separate knob because compliance teams often
  // require longer audit retention (default 365 days, 0 = keep forever).
  const auditRetentionDays = retentionDaysFromEnv('AUDIT_LOG_RETENTION_DAYS', 365);
  if (auditRetentionDays > 0) {
    try {
      // Policed since 040: the pool alone purges the default firm's and the
      // instance's rows only.
      const n = await withEveryTenant(db, async (trx) => {
        const r = await sql<{ deleted: number }>`
          WITH d AS (
            DELETE FROM zv_audit_log
            WHERE created_at < NOW() - (${auditRetentionDays}::int || ' days')::interval
            RETURNING 1
          )
          SELECT COUNT(*)::int AS deleted FROM d
        `.execute(trx);
        return r.rows[0]?.deleted ?? 0;
      });
      if (n > 0) {
        console.log(`[GC] zv_audit_log: ${n} rows older than ${auditRetentionDays}d purged`);
        totalDeleted += n;
      }
    } catch (err) {
      console.warn('[GC] zv_audit_log purge failed:', (err as Error).message);
    }
  }

  // Every firm's tombstones: the table is policed, and the pool alone would
  // purge the default firm's only.
  try {
    const n = await withEveryTenant(db, async (trx) => {
      const r = await sql<{ n: number }>`
        WITH d AS (
          DELETE FROM zv_sync_tombstones
          WHERE deleted_at < NOW() - make_interval(days => ${SYNC_TOMBSTONE_RETENTION_DAYS}::int)
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM d
      `.execute(trx);
      return r.rows[0]?.n ?? 0;
    });
    if (n > 0) {
      console.log(
        `[GC] zv_sync_tombstones: ${n} rows older than ${SYNC_TOMBSTONE_RETENTION_DAYS}d purged`,
      );
      totalDeleted += n;
    }
  } catch (err) {
    console.warn('[GC] zv_sync_tombstones purge failed:', (err as Error).message);
  }

  // ── Flow runs nobody finished ─────────────────────────────────────
  // A run is marked done by the process executing it. If that process dies
  // mid-run, or its final UPDATE fails, the row says 'running' forever. Every
  // step is bounded (timeouts of a minute or less), so a run started hours ago
  // is not running anywhere; ABANDONED_RUN_HOURS is far past any real run.
  try {
    const abandoned = await sql<{ n: number }>`
      WITH d AS (
        UPDATE zv_flow_runs
        SET status = 'failed',
            error = 'abandoned: still running after ' || ${ABANDONED_RUN_HOURS}::int || 'h — the executing process stopped or could not record the result',
            finished_at = NOW()
        WHERE status = 'running'
          AND started_at < NOW() - (${ABANDONED_RUN_HOURS}::int || ' hours')::interval
        RETURNING 1
      )
      SELECT COUNT(*)::int AS n FROM d
    `.execute(db);
    const n = abandoned.rows[0]?.n ?? 0;
    if (n > 0) console.warn(`[GC] zv_flow_runs: ${n} abandoned runs marked failed`);
  } catch (err) {
    console.warn('[GC] abandoned flow-run sweep failed:', (err as Error).message);
  }

  console.log(`[GC] Done. Total rows purged: ${totalDeleted}`);
}

/**
 * Schedules the garbage collector to run daily at 03:00.
 * Returns a cleanup function to stop the scheduler.
 */
export function scheduleGarbageCollector(db: Database): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function scheduleNext(): void {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    const msUntil = next.getTime() - now.getTime();
    console.log(
      `[GC] Next run scheduled at ${next.toISOString()} (in ${Math.round(msUntil / 60_000)} min)`,
    );

    timer = setTimeout(async () => {
      // Every replica wakes at 03:00; one runs the sweep, the rest find the
      // lock held and skip. The deletes were idempotent but not free.
      await tryAdvisoryLock(db, 'zveltio:garbage-collector', () => runGarbageCollector(db)).catch(
        (err) => {
          console.error('[GC] Error during garbage collection:', err);
        },
      );
      scheduleNext(); // Re-schedule for the next day
    }, msUntil);
  }

  scheduleNext();

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
