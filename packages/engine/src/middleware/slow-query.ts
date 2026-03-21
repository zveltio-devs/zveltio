import type { MiddlewareHandler } from 'hono';
import type { Database } from '../db/index.js';

const SLOW_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? '200');

export function slowQueryMiddleware(db: Database): MiddlewareHandler {
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
      (db as any)
        .insertInto('zv_slow_queries')
        .values({
          method: entry.method,
          path: entry.path,
          query_params: JSON.stringify(entry.query),
          status_code: entry.status,
          duration_ms: entry.duration_ms,
        })
        .execute()
        .catch(() => {});
    }
  };
}
