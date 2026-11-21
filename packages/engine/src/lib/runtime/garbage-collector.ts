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

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `AUDIT_LOG_RETENTION_TENANT_DAYS`: `<tenant id>=<days>,…`, each a whole
 * number of days (0 keeps that tenant's trail). A tenant id, not a slug: the
 * window must still hold for a purged tenant's rows, which outlive its slug.
 * null when any entry is malformed: an entry nobody can read may be the one
 * meant to keep a tenant's trail longer, so the audit purge does nothing.
 */
export function tenantRetentionDaysFromEnv(): Map<string, number> | null {
  const raw = process.env.AUDIT_LOG_RETENTION_TENANT_DAYS?.trim() ?? '';
  const out = new Map<string, number>();
  for (const entry of raw.split(',')) {
    if (entry.trim() === '') continue;
    const m = /^\s*([0-9a-fA-F-]{36})\s*=\s*(\d+)\s*$/.exec(entry);
    const id = m?.[1]?.toLowerCase();
    if (!m || !id || !TENANT_ID.test(id) || out.has(id)) {
      console.warn(
        `[GC] AUDIT_LOG_RETENTION_TENANT_DAYS entry ${JSON.stringify(entry.trim())} is not ` +
          '`<tenant id>=<whole days>` (or names a tenant twice); no audit row is purged.',
      );
      return null;
    }
    out.set(id, Number(m[2]));
  }
  return out;
}

/**
 * The audit purge, one chain per transaction (each tenant's, and the
 * instance's), as the one role that may delete audit rows. It publishes the
 * chain and its window, and the database lets it delete only that chain's rows
 * older than the window (migration 130); every firm's, a purged firm's
 * included. It deletes the chain's oldest rows up to the first one still inside
 * the window — or missing, which verify reports — and the database's cut
 * trigger moves the chain's genesis past them. Without the role it fails here,
 * loudly.
 */
async function purgeAuditChains(
  db: Database,
  instanceDays: number,
  tenantDays: Map<string, number>,
): Promise<number> {
  // ponytail: a full scan of the chain's tenant column each night; a skip scan
  // over (tenant_id, seq) when the chain is large enough for it to show.
  const chains = await sql<{ tenant_id: string | null }>`
    SELECT DISTINCT tenant_id::text AS tenant_id FROM zv_audit_chain`.execute(db);
  let total = 0;
  for (const { tenant_id } of chains.rows) {
    const days = (tenant_id === null ? undefined : tenantDays.get(tenant_id)) ?? instanceDays;
    if (days <= 0) continue;
    const own = (alias: string) =>
      tenant_id === null
        ? sql`${sql.ref(`${alias}.tenant_id`)} IS NULL`
        : sql`${sql.ref(`${alias}.tenant_id`)} = ${tenant_id}::uuid`;
    const chain = tenant_id ?? 'instance';
    try {
      const n = await db.transaction().execute(async (trx) => {
        await sql`
          SELECT set_config('role', 'zveltio_audit_purge', true),
                 set_config('zveltio.audit_retention_days', ${String(days)}, true),
                 set_config('zveltio.audit_purge_tenant', ${chain}, true)
        `.execute(trx);
        const r = await sql<{ deleted: number }>`
          WITH d AS (
            DELETE FROM zv_audit_log WHERE id IN (
              SELECT c.audit_id FROM zv_audit_chain c
               WHERE ${own('c')} AND c.seq < coalesce((
                 SELECT k.seq FROM zv_audit_chain k
                   LEFT JOIN zv_audit_log a ON a.id = k.audit_id
                         AND a.created_at < now() - make_interval(days => ${days}::int)
                  WHERE ${own('k')} AND a.id IS NULL
                  ORDER BY k.seq LIMIT 1), 9223372036854775807))
            RETURNING 1
          )
          SELECT COUNT(*)::int AS deleted FROM d
        `.execute(trx);
        return r.rows[0]?.deleted ?? 0;
      });
      if (n > 0) console.log(`[GC] zv_audit_log: ${n} rows of ${chain} older than ${days}d purged`);
      total += n;
    } catch (err) {
      console.warn(`[GC] zv_audit_log purge of ${chain} failed:`, (err as Error).message);
    }
  }
  return total;
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
  // require longer audit retention (default 365 days, 0 = keep forever), with a
  // window per tenant for a tenant under another jurisdiction (ADR 0060 d4).
  const auditRetentionDays = retentionDaysFromEnv('AUDIT_LOG_RETENTION_DAYS', 365);
  const tenantRetention = tenantRetentionDaysFromEnv();
  if (tenantRetention) {
    try {
      totalDeleted += await purgeAuditChains(db, auditRetentionDays, tenantRetention);
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
