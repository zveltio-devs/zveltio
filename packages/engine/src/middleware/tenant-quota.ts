import type { Context, Next } from 'hono';
import type { Database } from '../db/index.js';
import { getCache } from '../lib/cache.js';

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
export function tenantQuota(db: Database) {
  return async (c: Context, next: Next) => {
    const tenant = c.get('tenant') as any;

    // Single-tenant deployments have no tenant context — skip
    if (!tenant?.id) return next();

    const cache = getCache();
    if (!cache) return next();

    try {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const counterKey = `tq:${tenant.id}:${today}`;
      const limitKey   = `tq:limit:${tenant.id}`;

      // ── Fetch limit (cached) ──────────────────────────────────────────────
      let maxCalls = 0;
      const cached = await cache.get(limitKey);
      if (cached !== null) {
        maxCalls = parseInt(cached, 10);
      } else {
        const row = await (db as any)
          .selectFrom('zv_tenants')
          .select('max_api_calls_day')
          .where('id', '=', tenant.id)
          .executeTakeFirst()
          .catch(() => null);

        maxCalls = row?.max_api_calls_day ?? 0;
        // Cache for 5 minutes — plan upgrades propagate within that window
        await cache.set(limitKey, String(maxCalls), 'EX', 300).catch(() => {});
      }

      // 0 or null means "no limit configured" — allow all traffic
      if (!maxCalls || maxCalls <= 0) return next();

      // ── Increment counter ─────────────────────────────────────────────────
      const count = await cache.incr(counterKey);

      // Set expiry on the first call of the day so the key self-cleans at midnight
      if (count === 1) {
        const msUntilMidnight = new Date().setUTCHours(24, 0, 0, 0) - Date.now();
        await cache.expire(counterKey, Math.ceil(msUntilMidnight / 1000)).catch(() => {});
      }

      // ── Expose quota headers ──────────────────────────────────────────────
      c.header('X-Tenant-Quota-Limit',     String(maxCalls));
      c.header('X-Tenant-Quota-Remaining', String(Math.max(0, maxCalls - count)));

      if (count > maxCalls) {
        return c.json(
          { error: 'Daily API quota exceeded. Upgrade your plan for higher limits.' },
          429,
        );
      }

      // ── Async DB sync every 50 calls (non-blocking, for billing reports) ──
      if (count % 50 === 0) {
        (db as any)
          .insertInto('zv_tenant_usage')
          .values({ tenant_id: tenant.id, date: new Date(), api_calls: count })
          .onConflict((oc: any) =>
            oc.columns(['tenant_id', 'date']).doUpdateSet({ api_calls: count }),
          )
          .execute()
          .catch(() => { /* non-fatal — reporting lag is acceptable */ });
      }
    } catch {
      // Fail-open: quota errors must never block legitimate requests
    }

    return next();
  };
}
