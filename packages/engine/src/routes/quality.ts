/**
 * Data Quality Dashboard
 *
 * POST   /api/quality/scan                 — start async scan (202)
 * GET    /api/quality/scans/:collection    — list recent scans for collection
 * GET    /api/quality/scan/:scanId         — get scan status
 * GET    /api/quality/scan/:scanId/issues  — list issues for scan
 * POST   /api/quality/issues/:id/dismiss   — dismiss single issue
 * POST   /api/quality/scan/:scanId/dismiss-all — dismiss all issues
 * GET    /api/quality/summary              — cross-collection quality summary (admin)
 */

import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';
import { runQualityScan } from '../lib/data-quality.js';

const VALID_SCAN_TYPES = ['duplicates', 'anomalies', 'missing_data', 'normalization', 'full'];

export function qualityRoutes(db: Database, _auth: any): Hono {
  const app = new Hono<{ Variables: { user: any } }>();

  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    return next();
  });

  // POST /scan — start async scan
  app.post('/scan', async (c) => {
    const user = c.get('user');
    const body = await c.req.json();
    const { collection, scan_type = 'full' } = body;

    if (!collection) return c.json({ error: 'collection required' }, 400);
    if (!VALID_SCAN_TYPES.includes(scan_type)) {
      return c.json({ error: `scan_type must be one of: ${VALID_SCAN_TYPES.join(', ')}` }, 400);
    }

    const canRead = await checkPermission(user.id, collection, 'read');
    if (!canRead) return c.json({ error: 'Forbidden' }, 403);

    const scanId = await runQualityScan(db, collection, scan_type, user.id);
    return c.json({ scan_id: scanId, message: 'Scan started' }, 202);
  });

  // GET /scans/:collection — list recent scans
  app.get('/scans/:collection', async (c) => {
    const collection = c.req.param('collection');
    const scans = await (db as any)
      .selectFrom('zv_quality_scans')
      .selectAll()
      .where('collection', '=', collection)
      .orderBy('started_at', 'desc')
      .limit(10)
      .execute();
    return c.json({ scans });
  });

  // GET /scan/:scanId — get scan status
  app.get('/scan/:scanId', async (c) => {
    const scanId = c.req.param('scanId');
    const scan = await (db as any)
      .selectFrom('zv_quality_scans')
      .selectAll()
      .where('id', '=', scanId)
      .executeTakeFirst();
    if (!scan) return c.json({ error: 'Scan not found' }, 404);
    return c.json({ scan });
  });

  // GET /scan/:scanId/issues
  app.get('/scan/:scanId/issues', async (c) => {
    const scanId = c.req.param('scanId');
    const includeDismissed = c.req.query('dismissed') === 'true';

    let query = (db as any)
      .selectFrom('zv_quality_issues')
      .selectAll()
      .where('scan_id', '=', scanId);

    if (!includeDismissed) query = query.where('dismissed', '=', false);

    const issues = await query.orderBy('severity', 'asc').orderBy('created_at', 'asc').execute();
    return c.json({ issues });
  });

  // POST /issues/:id/dismiss
  app.post('/issues/:id/dismiss', async (c) => {
    const id = c.req.param('id');
    await (db as any).updateTable('zv_quality_issues').set({ dismissed: true }).where('id', '=', id).execute();
    return c.json({ success: true });
  });

  // POST /scan/:scanId/dismiss-all
  app.post('/scan/:scanId/dismiss-all', async (c) => {
    const scanId = c.req.param('scanId');
    await (db as any).updateTable('zv_quality_issues').set({ dismissed: true }).where('scan_id', '=', scanId).execute();
    return c.json({ success: true });
  });

  // GET /summary — admin only
  app.get('/summary', async (c) => {
    const user = c.get('user');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);

    const summary = await (db as any)
      .selectFrom('zv_quality_issues as i')
      .innerJoin('zv_quality_scans as s', 's.id', 'i.scan_id')
      .select(['i.collection', 'i.severity', (db as any).fn.count('i.id').as('count')])
      .where('i.dismissed', '=', false)
      .groupBy(['i.collection', 'i.severity'])
      .execute();

    const latestScans = await (db as any)
      .selectFrom('zv_quality_scans')
      .select(['collection', 'status', 'issues_found', 'completed_at'])
      .distinctOn(['collection'])
      .orderBy('collection')
      .orderBy('started_at', 'desc')
      .execute()
      .catch(() => []);

    return c.json({ summary, latest_scans: latestScans });
  });

  return app;
}
