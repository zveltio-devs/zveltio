/**
 * god-audit.ts
 *
 * Middleware that logs every action performed by a user with role='god' to
 * the zv_audit_log table. God users bypass all Casbin permission checks, so
 * this audit trail is the primary accountability mechanism for their actions.
 *
 * Usage (applies to all API routes):
 *   app.use('/api/*', godAuditMiddleware(db));
 */

import { createMiddleware } from 'hono/factory';
import type { Database } from '../db/index.js';

async function logGodAction(
  db: Database,
  params: {
    userId: string;
    method: string;
    path: string;
    status: number;
    durationMs: number;
    ip: string | null;
  },
): Promise<void> {
  try {
    await db
      .insertInto('zv_audit_log')
      .values({
        event_type: 'god_action',
        user_id: params.userId,
        resource_type: params.method,
        resource_id: params.path,
        metadata: {
          method: params.method,
          path: params.path,
          status: params.status,
          duration_ms: params.durationMs,
        },
        ip: params.ip,
      })
      .execute();
  } catch (err) {
    // Audit logging must never break the request — log to stderr only
    console.error('[god-audit] Failed to write audit entry:', err);
  }
}

/**
 * Wraps all /api/* requests and emits an audit log entry when the acting
 * user has the 'god' role. The log is written asynchronously so it does not
 * add latency to the response.
 */
export function godAuditMiddleware(db: Database) {
  return createMiddleware(async (c, next) => {
    const start = Date.now();
    await next();

    // Post-response: inspect session to check for god role
    // We read the user from context after next() to avoid double-resolution.
    try {
      const user = (c.get as any)('user') as { id: string; role?: string } | undefined;
      if (user?.role === 'god') {
        const durationMs = Date.now() - start;
        const ip =
          c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
          c.req.header('x-real-ip') ??
          null;

        // Fire-and-forget — intentionally not awaited
        logGodAction(db, {
          userId: user.id,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs,
          ip,
        }).catch(() => {/* already logged inside logGodAction */});
      }
    } catch {
      // Never propagate errors from the audit middleware
    }
  });
}
