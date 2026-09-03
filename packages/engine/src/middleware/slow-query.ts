import { onAfterCommit } from '../lib/tenancy/index.js';
import type { MiddlewareHandler } from 'hono';
import type { Database } from '../db/index.js';
import { toJsonb } from '../lib/jsonb.js';

const SLOW_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? '200');

/**
 * @param poolDb a PLAIN pool handle — see `requestLogMiddleware` for why. The
 * failure mode is sharper here: a slow request is disproportionately one that
 * went on to fail, and the record of it was dropped on the aborted transaction
 * it left behind. `zv_slow_queries` carries no `tenant_id`.
 */
export function slowQueryMiddleware(poolDb: Database): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const duration = performance.now() - start;

    if (duration > SLOW_THRESHOLD_MS) {
      const entry = {
        method: c.req.method,
        path: c.req.path,
        query: c.req.query(),
        status: c.res.status,
        duration_ms: Math.round(duration),
        timestamp: new Date().toISOString(),
      };

      // Log to console in dev
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[slow-query]', entry);
      }

      // Persist to DB (fire-and-forget, non-fatal)
      // Deferred until the COMMIT, like the request log and the god audit.
      //
      // This writes to the POOL while the request's tenant transaction is still
      // open — the middleware sits inside it, so "after next()" is still "before
      // commit" — and the connection is taken the moment the statement is
      // issued, awaited or not. That is a second connection on `/api/data/*`,
      // the hottest path there is, and at `c = DB_POOL_MAX` the second one can
      // never arrive.
      onAfterCommit(() => {
        poolDb
          .insertInto('zv_slow_queries')
          .values({
            method: entry.method,
            path: entry.path,
            query_params: toJsonb(entry.query),
            status_code: entry.status,
            duration_ms: entry.duration_ms,
          })
          .execute()
          .catch((err: Error) => {
            console.warn('[slow-query] write failed:', err.message);
          });
      });
    }
  };
}
