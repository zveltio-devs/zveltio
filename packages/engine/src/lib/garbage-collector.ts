/**
 * Garbage Collector — deletes soft-deleted rows older than 30 days.
 *
 * Scans all tenant_ + public schemas, finds tables with column
 * "_deletedAt" and executes DELETE for expired rows.
 *
 * Runs automatically at 03:00 every night (scheduled by flow-scheduler).
 */

import { sql } from 'kysely';
import type { Database } from '../db/index.js';

export async function runGarbageCollector(db: Database): Promise<void> {
  console.log('[GC] Starting garbage collection...');

  // Collect all schemas: tenant_* + public
  const schemasResult = await sql<{ schema_name: string }>`
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%' OR schema_name = 'public'
    ORDER BY schema_name
  `.execute(db);

  const schemas = schemasResult.rows.map((r) => r.schema_name);
  let totalDeleted = 0;

  for (const schema of schemas) {
    // Find tables in this schema that have column _deletedAt
    const tablesResult = await sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = ${schema}
        AND column_name = '_deletedAt'
    `.execute(db);

    for (const { table_name } of tablesResult.rows) {
      try {
        const result = await sql`
          DELETE FROM ${sql.id(schema, table_name)}
          WHERE "_deletedAt" < NOW() - INTERVAL '30 days'
        `.execute(db);

        const deleted = Number((result as any).numAffectedRows ?? 0);
        if (deleted > 0) {
          console.log(`[GC] ${schema}.${table_name}: ${deleted} rows deleted`);
          totalDeleted += deleted;
        }
      } catch {
        // Table may be unavailable or there may be an error — skip silently
      }
    }
  }

  // ── Retention purges for high-churn audit tables ──────────────────
  // zv_request_logs grows ~one row per API call — without a retention
  // sweep the table reaches hundreds of millions of rows on a busy
  // deployment and starts hurting writes. REQUEST_LOG_RETENTION_DAYS
  // controls the cutoff (default 30, set to 0 to keep forever).
  // Same shape extended to zv_slow_queries; both are observability
  // tables, not source of truth for anything.
  const retentionDays = parseInt(process.env.REQUEST_LOG_RETENTION_DAYS ?? '30', 10);
  if (retentionDays > 0) {
    try {
      const reqDeleted = await sql<{ deleted: number }>`
        WITH d AS (
          DELETE FROM zv_request_logs
          WHERE created_at < NOW() - (${retentionDays}::int || ' days')::interval
          RETURNING 1
        )
        SELECT COUNT(*)::int AS deleted FROM d
      `
        .execute(db)
        .catch(() => ({ rows: [] as Array<{ deleted: number }> }));
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
      `
        .execute(db)
        .catch(() => ({ rows: [] as Array<{ deleted: number }> }));
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
  const auditRetentionDays = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS ?? '365', 10);
  if (auditRetentionDays > 0) {
    try {
      const auditDeleted = await sql<{ deleted: number }>`
        WITH d AS (
          DELETE FROM zv_audit_log
          WHERE created_at < NOW() - (${auditRetentionDays}::int || ' days')::interval
          RETURNING 1
        )
        SELECT COUNT(*)::int AS deleted FROM d
      `
        .execute(db)
        .catch(() => ({ rows: [] as Array<{ deleted: number }> }));
      const n = auditDeleted.rows[0]?.deleted ?? 0;
      if (n > 0) {
        console.log(`[GC] zv_audit_log: ${n} rows older than ${auditRetentionDays}d purged`);
        totalDeleted += n;
      }
    } catch (err) {
      console.warn('[GC] zv_audit_log purge failed:', (err as Error).message);
    }
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
      await runGarbageCollector(db).catch((err) => {
        console.error('[GC] Error during garbage collection:', err);
      });
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
