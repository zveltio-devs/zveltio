/**
 * SQL Editor — admin-only ad-hoc SQL execution.
 *
 * POST /api/admin/sql  →  { query: "...", timeout_ms?: number }  →  { rows, rowCount }
 *
 * Safety:
 *  - Admin-only (requires session + admin permission).
 *  - Audited via auditLog so we have a paper trail of who ran what.
 *  - Statement-level timeout (default 30s, max 5min) enforced via
 *    `SET LOCAL statement_timeout` so a runaway admin query can't
 *    pin a pool connection indefinitely.
 *  - READ ONLY by default. `mode: 'write'` opts into DDL/DML, is recorded as a
 *    distinct audit event, and has to be asked for.
 *
 * The read-only default is enforced by Postgres (`SET TRANSACTION READ ONLY`),
 * not by inspecting the SQL. Any check that reads the query text loses: casing,
 * comments, and `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` all
 * defeat a keyword blocklist, and the statement that gets past it runs with
 * full instance-admin rights. Postgres refusing the write is the only version
 * of this that cannot be phrased around.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'kysely';
import { zValidator } from '@hono/zod-validator';
import type { Database } from '../db/index.js';
import { checkPermission, requireInstanceAdmin } from '../lib/tenancy/index.js';
import { auditLog } from '../lib/audit.js';

const SqlSchema = z.object({
  query: z.string().min(1).max(50_000),
  // 100ms minimum to allow CI smoke tests; 5min ceiling to stop a
  // forgotten CREATE INDEX from squatting the connection forever.
  timeout_ms: z.number().int().min(100).max(300_000).optional(),
  /**
   * Default 'read'. An admin who means to change data says so, and the audit
   * trail then distinguishes the two — which matters when the question months
   * later is "who dropped that table", and the answer used to be a list of
   * every query anyone had ever run from this screen.
   */
  mode: z.enum(['read', 'write']).default('read'),
});

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function sqlEditorRoutes(db: Database, auth: any): Hono {
  const router = new Hono();

  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await requireInstanceAdmin(session.user.id))) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    c.set('user', session.user);
    await next();
  });

  router.post('/', zValidator('json', SqlSchema), async (c) => {
    const { query, timeout_ms = 30_000, mode } = c.req.valid('json');
    const user = c.get('user') as { id: string };
    const start = Date.now();
    try {
      // Run inside a transaction with SET LOCAL statement_timeout so the
      // timeout binds to the same connection as the user query. Without
      // this wrap, `.execute(db)` on the pool can hand SET LOCAL and the
      // query to different connections and the cap becomes a no-op.
      const seconds = Math.max(1, Math.ceil(timeout_ms / 1000));
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const result = await (db as any).transaction().execute(async (trx: any) => {
        await sql.raw(`SET LOCAL statement_timeout = '${seconds}s'`).execute(trx);
        // Before the query, and inside the same transaction, so it binds to the
        // statement that is about to run.
        if (mode === 'read') {
          await sql.raw('SET TRANSACTION READ ONLY').execute(trx);
        }
        return sql.raw(query).execute(trx);
      });
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const rows = ((result as any).rows ?? []) as Record<string, unknown>[];

      // Audit every successful execution — content stored, but truncated.
      auditLog(db, {
        type: mode === 'write' ? 'sql.write.executed' : 'sql.executed',
        userId: user.id,
        resourceType: 'sql',
        metadata: {
          query: query.slice(0, 2000),
          mode,
          row_count: rows.length,
          ms: Date.now() - start,
        },
      }).catch((err: Error) => {
        console.warn('[sql-editor] audit log failed:', err.message);
      });

      return c.json({ rows, rowCount: rows.length, ms: Date.now() - start });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      auditLog(db, {
        type: 'sql.failed',
        userId: user.id,
        resourceType: 'sql',
        metadata: { query: query.slice(0, 2000), mode, error: message },
      }).catch((auditErr: Error) => {
        console.warn('[sql-editor] failure audit write failed:', auditErr.message);
      });
      return c.json({ error: message }, 400);
    }
  });

  return router;
}
