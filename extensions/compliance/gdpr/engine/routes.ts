/**
 * GDPR Compliance
 *
 * GET    /api/gdpr/export-my-data   — Export all user data as JSON attachment
 * DELETE /api/gdpr/delete-my-account — Right to erasure (requires confirmation)
 */

import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../../../packages/engine/src/db/index.js';
import { auth } from '../../../../packages/engine/src/lib/auth.js';

export function gdprRoutes(db: Database, _auth: any): Hono {
  const app = new Hono();

  // GET /export-my-data
  app.get('/export-my-data', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    const userId = session.user.id;

    const [userRow, auditRows, notifRows, apiKeyRows, approvalRows] = await Promise.all([
      sql<any>`SELECT id::text, name, email, created_at FROM "user" WHERE id = ${userId}`.execute(db),
      sql<any>`SELECT action, collection, record_id, created_at FROM zv_audit_log WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1000`.execute(db),
      sql<any>`SELECT title, message, type, is_read, created_at FROM zv_notifications WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 500`.execute(db),
      sql<any>`SELECT name, key_prefix, scopes, created_at FROM zv_api_keys WHERE created_by = ${userId}`.execute(db),
      sql<any>`SELECT id::text, collection, record_id, status, requested_at FROM zv_approval_requests WHERE requested_by = ${userId} ORDER BY requested_at DESC`.execute(db).catch(() => ({ rows: [] })),
    ]);

    const exportData = {
      exported_at: new Date().toISOString(),
      profile: userRow.rows[0] || null,
      audit_log: auditRows.rows,
      notifications: notifRows.rows,
      api_keys: apiKeyRows.rows,
      approval_requests: approvalRows.rows,
    };

    const json = JSON.stringify(exportData, null, 2);
    return new Response(json, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="my-data-export-${new Date().toISOString().split('T')[0]}.json"`,
      },
    });
  });

  // DELETE /delete-my-account
  app.delete('/delete-my-account', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json().catch(() => ({}));
    if (body.confirm !== 'DELETE MY ACCOUNT') {
      return c.json({ error: 'Please confirm with: { "confirm": "DELETE MY ACCOUNT" }' }, 400);
    }

    // Re-autentificare obligatorie: verifică parola curentă
    if (!body.password) {
      return c.json({
        error: 'Current password required for account deletion. Include "password" in request body.',
      }, 400);
    }

    // Verifică parola prin Better-Auth
    try {
      const verifyResult = await auth.api.signInEmail({
        body: { email: session.user.email, password: body.password },
      });
      if (!verifyResult) throw new Error('Invalid password');
    } catch {
      return c.json({ error: 'Invalid password. Account deletion cancelled.' }, 403);
    }

    const userId = session.user.id;

    await sql`
      INSERT INTO zv_audit_log (user_id, action, collection, metadata)
      VALUES (${userId}, 'gdpr.account_deleted', 'user', '{"gdpr": true}'::jsonb)
    `.execute(db);

    await sql`DELETE FROM zv_api_keys WHERE created_by = ${userId}`.execute(db);
    await sql`DELETE FROM zv_notifications WHERE user_id = ${userId}`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${userId}`.execute(db);

    return c.json({ success: true, message: 'Account and all associated data has been deleted' });
  });

  return app;
}
