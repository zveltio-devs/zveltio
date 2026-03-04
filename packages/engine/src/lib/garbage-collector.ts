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
