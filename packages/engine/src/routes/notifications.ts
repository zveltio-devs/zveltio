import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';

async function requireAuth(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// Helper to send a notification to one or more users
export async function sendNotification(
  db: Database,
  opts: {
    user_id: string | string[];
    title: string;
    message: string;
    type?: 'info' | 'success' | 'warning' | 'error';
    action_url?: string;
    source?: string;
    metadata?: Record<string, any>;
  },
): Promise<void> {
  const userIds = Array.isArray(opts.user_id) ? opts.user_id : [opts.user_id];
  const values = userIds.map((uid) => ({
    user_id: uid,
    title: opts.title,
    message: opts.message,
    type: opts.type ?? 'info',
    action_url: opts.action_url ?? null,
    source: opts.source ?? null,
    metadata: JSON.stringify(opts.metadata ?? {}),
  }));

  // Insert each notification individually so a single invalid user_id (FK miss,
  // deleted account) does not cause the entire batch to fail silently.
  // Promise.allSettled ensures all valid entries are delivered even if some fail.
  const results = await Promise.allSettled(
    values.map((v) =>
      (db as any).insertInto('zv_notifications').values(v).execute(),
    ),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    console.error(
      `[sendNotification] ${failed.length}/${values.length} notifications failed:`,
      (failed[0] as PromiseRejectedResult).reason,
    );
  }
}

export function notificationsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    const user = await requireAuth(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET / — List notifications for current user
  app.get('/', async (c) => {
    const user = c.get('user') as any;
    const { unread_only, limit = '50', page = '1' } = c.req.query();
    const lim = Math.min(parseInt(limit), 200);
    const offset = (parseInt(page) - 1) * lim;

    let query = (db as any)
      .selectFrom('zv_notifications')
      .selectAll()
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .limit(lim)
      .offset(offset);

    if (unread_only === 'true') query = query.where('is_read', '=', false);

    const [notifications, countRow] = await Promise.all([
      query.execute(),
      (db as any)
        .selectFrom('zv_notifications')
        .select((eb: any) => [
          eb.fn.count('id').as('total'),
          sql`SUM(CASE WHEN is_read = false THEN 1 ELSE 0 END)::int`.as('unread'),
        ])
        .where('user_id', '=', user.id)
        .executeTakeFirst(),
    ]);

    return c.json({
      notifications,
      stats: {
        total: parseInt(countRow?.total ?? '0'),
        unread: parseInt(countRow?.unread ?? '0'),
      },
    });
  });

  // GET /:id — Get single notification
  app.get('/:id', async (c) => {
    const user = c.get('user') as any;
    const notification = await (db as any)
      .selectFrom('zv_notifications')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    if (!notification) return c.json({ error: 'Notification not found' }, 404);
    return c.json({ notification });
  });

  // PATCH /:id/read — Mark as read
  app.patch('/:id/read', async (c) => {
    const user = c.get('user') as any;
    await (db as any)
      .updateTable('zv_notifications')
      .set({ is_read: true })
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ success: true });
  });

  // PATCH /:id/unread — Mark as unread
  app.patch('/:id/unread', async (c) => {
    const user = c.get('user') as any;
    await (db as any)
      .updateTable('zv_notifications')
      .set({ is_read: false })
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ success: true });
  });

  // POST /mark-all-read — Mark all as read for user
  app.post('/mark-all-read', async (c) => {
    const user = c.get('user') as any;
    await (db as any)
      .updateTable('zv_notifications')
      .set({ is_read: true })
      .where('user_id', '=', user.id)
      .where('is_read', '=', false)
      .execute();
    return c.json({ success: true });
  });

  // DELETE /clear-all — Clear all read notifications (must be before DELETE /:id to prevent route conflict)
  app.delete('/clear-all', async (c) => {
    const user = c.get('user') as any;
    await (db as any)
      .deleteFrom('zv_notifications')
      .where('user_id', '=', user.id)
      .where('is_read', '=', true)
      .execute();
    return c.json({ success: true });
  });

  // DELETE /:id — Delete notification
  app.delete('/:id', async (c) => {
    const user = c.get('user') as any;
    await (db as any)
      .deleteFrom('zv_notifications')
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ success: true });
  });

  // ── Web Push Subscriptions ────────────────────────────────────

  // POST /push/subscribe — Subscribe to web push
  app.post(
    '/push/subscribe',
    zValidator('json', z.object({
      endpoint: z.string().url(),
      p256dh: z.string(),
      auth: z.string(),
      user_agent: z.string().optional(),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const { endpoint, p256dh, auth: authKey, user_agent } = c.req.valid('json');

      await sql`
        INSERT INTO zv_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
        VALUES (${user.id}, ${endpoint}, ${p256dh}, ${authKey}, ${user_agent ?? null})
        ON CONFLICT (endpoint) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth
      `.execute(db);

      return c.json({ success: true }, 201);
    },
  );

  // DELETE /push/subscribe — Unsubscribe
  app.delete('/push/subscribe', async (c) => {
    const user = c.get('user') as any;
    const { endpoint } = await c.req.json();
    await (db as any)
      .deleteFrom('zv_push_subscriptions')
      .where('user_id', '=', user.id)
      .where('endpoint', '=', endpoint)
      .execute();
    return c.json({ success: true });
  });

  // ── Admin: Broadcast notifications ───────────────────────────

  // POST /broadcast — Send notification to one or all users (admin)
  app.post(
    '/broadcast',
    zValidator('json', z.object({
      user_id: z.union([z.string(), z.array(z.string())]).optional(), // omit = all users
      title: z.string().min(1).max(200),
      message: z.string().min(1).max(2000),
      type: z.enum(['info', 'success', 'warning', 'error']).default('info'),
      action_url: z.string().url().optional(),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const isAdmin = await checkPermission(user.id, 'admin', '*');
      if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);

      const { user_id, title, message, type, action_url } = c.req.valid('json');

      let targetIds: string[];
      if (user_id) {
        targetIds = Array.isArray(user_id) ? user_id : [user_id];
      } else {
        // Broadcast to all active users
        const users = await (db as any)
          .selectFrom('user')
          .select('id')
          .execute();
        targetIds = users.map((u: any) => u.id);
      }

      await sendNotification(db, {
        user_id: targetIds,
        title,
        message,
        type,
        action_url,
        source: 'admin_broadcast',
      });

      return c.json({ success: true, sent_to: targetIds.length });
    },
  );

  return app;
}
