import type { MiddlewareHandler } from 'hono';
import type { Database } from '../db/index.js';

// Log every /api/* request to zv_request_logs (fire-and-forget, non-fatal).
// Skips health, metrics, and auth endpoints to reduce noise.
const SKIP_PREFIXES = ['/api/health', '/api/metrics', '/api/auth'];

export function requestLogMiddleware(db: Database): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const skip = SKIP_PREFIXES.some((p) => path.startsWith(p));

    const start = performance.now();
    await next();

    if (skip) return;

    const duration = Math.round(performance.now() - start);
    const user = c.get('user') as any;

    (db as any)
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
      .catch(() => { /* non-fatal */ });
  };
}
