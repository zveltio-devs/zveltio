import type { MiddlewareHandler } from 'hono';
import type { Database } from '../db/index.js';

// Log /api/* requests to zv_request_logs (fire-and-forget, non-fatal).
// Skips health, metrics, and auth endpoints to reduce noise.
const SKIP_PREFIXES = ['/api/health', '/api/metrics', '/api/auth'];

// Sampling bounds write amplification on high-traffic installs. Default 1.0
// (log everything) preserves prior behaviour; REQUEST_LOG_SAMPLE_RATE=0.1 keeps
// ~10%, 0 disables success logging entirely. Non-2xx responses are ALWAYS
// logged regardless of the rate, so errors are never sampled away.
const SAMPLE_RATE = (() => {
  const raw = Number(process.env.REQUEST_LOG_SAMPLE_RATE ?? '1');
  if (!Number.isFinite(raw)) return 1;
  return Math.min(1, Math.max(0, raw));
})();

/**
 * @param poolDb a PLAIN pool handle, never the request-scoped proxy.
 *
 * This write happens after `next()` and is deliberately not awaited, which puts
 * it outside the request's tenant transaction in both directions. Handed the
 * scoped proxy it resolved that transaction anyway, and then:
 *
 *   - a request that failed on a database error left the transaction aborted,
 *     so the INSERT came back "current transaction is aborted, commands ignored"
 *     and the log line was dropped. Exactly inverting the intent above — errors
 *     are never sampled away — because the requests that fail hardest are the
 *     ones that fail this way;
 *   - a request that succeeded raced the COMMIT. The statement is issued as the
 *     middleware unwinds and the transaction closes right behind it, so the
 *     INSERT can land on a connection already back in the pool.
 *
 * `zv_request_logs` carries no `tenant_id`, so nothing is lost by leaving the
 * tenant transaction — the row was never scoped by it.
 */
export function requestLogMiddleware(poolDb: Database): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const skip = SKIP_PREFIXES.some((p) => path.startsWith(p));

    const start = performance.now();
    await next();

    if (skip) return;

    // Always record failures; sample successes to bound table growth.
    const isError = c.res.status >= 400;
    if (!isError && SAMPLE_RATE < 1 && (SAMPLE_RATE === 0 || Math.random() >= SAMPLE_RATE)) {
      return;
    }

    const duration = Math.round(performance.now() - start);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = c.get('user') as any;

    poolDb
      .insertInto('zv_request_logs')
      .values({
        method: c.req.method,
        path,
        status: c.res.status,
        duration_ms: duration,
        user_id: user?.id ?? null,
        ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null,
        user_agent: c.req.header('user-agent') ?? null,
      })
      .execute()
      .catch((err: Error) => {
        // Request log is best-effort — log loudly so a wedged audit
        // pipeline doesn't go unnoticed (every request loses traceability).
        console.warn('[request-log] write failed:', err.message);
      });
  };
}
