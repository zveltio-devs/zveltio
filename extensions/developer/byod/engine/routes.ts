import { Hono } from 'hono';
import { auth } from '../../../../packages/engine/src/lib/auth.js';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';
import type { Database } from '../../../../packages/engine/src/db/index.js';
import { introspectSchema } from '../../../../packages/engine/src/lib/introspection.js';

export function introspectRoutes(db: Database, _auth: any): Hono {
  const router = new Hono();

  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin required' }, 403);
    await next();
  });

  /**
   * GET /api/introspect/preview
   * Dry-run: returnează tabelele găsite fără a le scrie în zvd_collections.
   * Query params: schema (default: public), exclude (comma-separated substrings)
   */
  router.get('/preview', async (c) => {
    const schema = c.req.query('schema') || 'public';
    const exclude = c.req.query('exclude')?.split(',').filter(Boolean) ?? [];

    try {
      const tables = await introspectSchema(db, schema, exclude, true);
      return c.json({ tables, schema, total: tables.length });
    } catch (err: any) {
      return c.json({ error: err.message || 'Introspection failed' }, 500);
    }
  });

  /**
   * POST /api/introspect
   * Scanează schema și importă tabelele ca unmanaged collections (is_managed = false).
   * Body: { schema?: string, exclude?: string[] }
   */
  router.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const schema: string = body.schema || 'public';
    const exclude: string[] = Array.isArray(body.exclude) ? body.exclude : [];

    try {
      const tables = await introspectSchema(db, schema, exclude, false);
      return c.json({
        imported: tables.filter((t) => t.isNew).length,
        updated: tables.filter((t) => !t.isNew).length,
        tables,
      });
    } catch (err: any) {
      return c.json({ error: err.message || 'Introspection failed' }, 500);
    }
  });

  return router;
}
