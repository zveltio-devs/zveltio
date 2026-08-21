import type { Context, Next } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { getCache } from '../lib/runtime/index.js';

/**
 * Tenant daily API quota enforcement.
 *
 * Uses a Redis counter (`tq:{tenantId}:{YYYY-MM-DD}`) as the fast path.
 * The per-tenant limit (`max_api_calls_day`) is cached in Redis with TTL 300 s
 * to avoid a DB query on every request.
 *
 * Fails open: if Redis or the DB is unavailable the request is allowed through.
 * Every 50 calls the Redis counter is synced back to `zv_tenant_usage` (non-blocking)
 * so the reporting table stays reasonably up to date.
 *
 * Registers after the tenant middleware so `c.get('tenant')` is available.
 */
/**
 * @param db      the request-scoped handle, kept for the quota LOOKUP.
 * @param poolDb  a plain pool handle for the usage counter. Optional so existing
 *   callers and tests keep working; falls back to `db`.
 *
 * The counter is deliberately NOT written through the request transaction. It is
 * billing telemetry, not part of the caller's business transaction: a request
 * that rolls back still consumed the call, and — the reason this is a parameter
 * at all — an unawaited write on a transaction that is about to commit either
 * lands on a closed one or takes the whole request down with it when it fails.
 * It has its own connection because it has its own lifetime.
 */
export function tenantQuota(db: Database, poolDb?: Database) {
  const quotaDb = poolDb ?? db;
  return async (c: Context, next: Next) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const tenant = c.get('tenant') as any;

    // Single-tenant deployments have no tenant context — skip
    if (!tenant?.id) return next();

    const cache = getCache();
    if (!cache) return next();

    try {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const counterKey = `tq:${tenant.id}:${today}`;
      const limitKey = `tq:limit:${tenant.id}`;

      // ── Fetch limit (cached) ──────────────────────────────────────────────
      let maxCalls = 0;
      const cached = await cache.get(limitKey);
      if (cached !== null) {
        maxCalls = parseInt(cached, 10);
      } else {
        // `.catch(() => null)` here collapsed into `maxCalls = 0`, which three lines
        // down means "no limit configured - allow all traffic". So a transient database
        // error switched the quota OFF, and the line below then CACHED that fabricated
        // zero for five minutes: every request in the window re-read it and passed. A
        // quota a database hiccup disables, and then remembers, is not a quota.
        //
        // A read failure is now told apart from a configured zero. The request still
        // passes - refusing traffic because a metering lookup blipped would turn a
        // nuisance into an outage - but it passes LOUDLY, and the value is not cached,
        // so the next request tries again instead of inheriting the mistake.
        let row: { max_api_calls_day: number | null } | undefined;
        try {
          row = await db
            .selectFrom('zv_tenants')
            .select('max_api_calls_day')
            .where('id', '=', tenant.id)
            .executeTakeFirst();
        } catch (err) {
          console.error(
            `[tenant-quota] could not read the API limit for tenant ${tenant.id}; this ` +
              `request is NOT being metered and the limit is not being cached:`,
            err instanceof Error ? err.message : err,
          );
          return next();
        }

        maxCalls = row?.max_api_calls_day ?? 0;
        // Cache for 5 minutes — plan upgrades propagate within that window
        await cache.set(limitKey, String(maxCalls), 'EX', 300).catch((err: Error) => {
          console.warn('[tenant-quota] cache.set(limit) failed:', err.message);
        });
      }

      // 0 or null means "no limit configured" — allow all traffic
      if (!maxCalls || maxCalls <= 0) return next();

      // ── Increment counter ─────────────────────────────────────────────────
      const count = await cache.incr(counterKey);

      // Set expiry on the first call of the day so the key self-cleans at midnight
      if (count === 1) {
        const msUntilMidnight = new Date().setUTCHours(24, 0, 0, 0) - Date.now();
        await cache.expire(counterKey, Math.ceil(msUntilMidnight / 1000)).catch((err: Error) => {
          console.warn('[tenant-quota] cache.expire(counter) failed:', err.message);
        });
      }

      // ── Expose quota headers ──────────────────────────────────────────────
      c.header('X-Tenant-Quota-Limit', String(maxCalls));
      c.header('X-Tenant-Quota-Remaining', String(Math.max(0, maxCalls - count)));

      if (count > maxCalls) {
        return c.json(
          { error: 'Daily API quota exceeded. Upgrade your plan for higher limits.' },
          429,
        );
      }

      // ── Async DB sync every 50 calls (non-blocking, for billing reports) ──
      //
      // `date` is a DATE column and this used to pass a JS `Date`, which the
      // driver stringifies as "Mon Aug 10 2026 06:28:21 GMT+0000 (Coordinated
      // Universal Time)" — rejected outright with `invalid input syntax for
      // type date`. Every fiftieth request, on any instance with the cache
      // enabled, for as long as this has existed.
      //
      // It looked harmless because the failure is caught and logged. It was not:
      // a failed statement aborts the whole Postgres transaction, and a
      // JavaScript `catch` does not undo that. Once this write ran on the
      // request's tenant transaction, the read that followed it died with
      // `25P02 current transaction is aborted` and the caller got a 500 from a
      // GET that had nothing to do with quotas.
      //
      // UTC to match `counterKey`, which expires at UTC midnight.
      if (count % 50 === 0) {
        //
        // Sent as a literal cast to `date` rather than a JS value. The generated
        // schema types this column as `Date`, which is what the driver hands
        // BACK on a read — but it is not what the driver can send, and that
        // mismatch is the whole bug above. `sql` states the intent in the one
        // place the type system cannot.
        const day = sql<Date>`${new Date().toISOString().slice(0, 10)}::date`;
        quotaDb
          .insertInto('zv_tenant_usage')
          .values({ tenant_id: tenant.id, date: day, api_calls: count })
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          .onConflict((oc: any) =>
            oc.columns(['tenant_id', 'date']).doUpdateSet({ api_calls: count }),
          )
          .execute()
          .catch((err: Error) => {
            console.warn('[tenant-quota] usage report write failed:', err.message);
          });
      }
    } catch (err) {
      // Fail-open: quota errors must never block legitimate requests, but
      // surface them so a wedged Valkey/DB doesn't silently disable quotas.
      console.warn('[tenant-quota] middleware error (fail-open):', (err as Error).message);
    }

    return next();
  };
}
