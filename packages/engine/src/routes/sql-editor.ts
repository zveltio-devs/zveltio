/**
 * SQL Editor — admin-only ad-hoc SQL execution.
 *
 * POST /api/admin/sql  →  { query: "..." }  →  { rows, rowCount }
 *
 * Safety:
 *  - Admin-only (requires session + admin permission).
 *  - Audited via auditLog so we have a paper trail of who ran what.
 *  - Uses pool.unsafe() — no prepared statement caching, simple-query protocol —
 *    which intentionally allows multi-statement scripts (CREATE + INSERT + ...).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'kysely';
import { zValidator } from '@hono/zod-validator';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { auditLog } from '../lib/audit.js';

const SqlSchema = z.object({
  query: z.string().min(1).max(50_000),
});

export function sqlEditorRoutes(db: Database, auth: any): Hono {
  const router = new Hono();

  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await checkPermission(session.user.id, 'admin', '*'))) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    c.set('user', session.user);
    await next();
  });

  router.post('/', zValidator('json', SqlSchema), async (c) => {
    const { query } = c.req.valid('json');
    const user = c.get('user') as { id: string };
    const start = Date.now();
    try {
      const result = await sql.raw(query).execute(db);
      const rows = (result.rows ?? []) as Record<string, unknown>[];

      // Audit every successful execution — content stored, but truncated.
      auditLog(db, {
        type: 'sql.executed',
        userId: user.id,
        resourceType: 'sql',
        metadata: {
          query: query.slice(0, 2000),
          row_count: rows.length,
          ms: Date.now() - start,
        },
      }).catch(() => {});

      return c.json({ rows, rowCount: rows.length, ms: Date.now() - start });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      auditLog(db, {
        type: 'sql.failed',
        userId: user.id,
        resourceType: 'sql',
        metadata: { query: query.slice(0, 2000), error: message },
      }).catch(() => {});
      return c.json({ error: message }, 400);
    }
  });

  return router;
}
