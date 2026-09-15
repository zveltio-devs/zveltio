import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { DEFAULT_TENANT_ID, isTenantAdmin } from '../lib/tenancy/index.js';
import { getVapidConfig, isValidAuthSecret, isValidP256dh } from '../lib/web-push.js';
import { reqDb, tenantId } from '../lib/route-db.js';
import { validatePublicUrl } from '../lib/edge-functions/safe-fetch.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
async function requireAuth(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// `sendNotification` and `_settleNotificationPushes` live in lib/notifications.ts
// and are re-exported here.
//
// There were two of them for a long time: this one, which wrote a batch and
// sent push, and lib/notifications.ts, which wrote a single row and sent none.
// Extensions are handed the lib one through `ctx.internals`, so every
// notification an extension raised was silently excluded from mobile and
// browser push — the twin problem this campaign keeps finding, with the two
// copies in different directories and only one of them growing features.
import { _settleNotificationPushes, sendNotification } from '../lib/notifications.js';
export { _settleNotificationPushes, sendNotification };

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    const tdb = reqDb(c, db);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    const { unread_only, limit = '50', page = '1' } = c.req.query();
    const lim = Math.min(parseInt(limit), 200);
    const offset = (parseInt(page) - 1) * lim;

    let query = tdb
      .selectFrom('zv_notifications')
      .selectAll()
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .limit(lim)
      .offset(offset);

    if (unread_only === 'true') query = query.where('is_read', '=', false);

    const [notifications, countRow] = await Promise.all([
      query.execute(),
      tdb
        .selectFrom('zv_notifications')
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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

  // GET /push-tokens — list own tokens. MUST precede /:id, else the param
  // route captures "push-tokens" as :id and the UUID cast 500s.
  app.get('/push-tokens', async (c) => {
    const tdb = reqDb(c, db);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    const tokens = await tdb
      .selectFrom('zvd_push_tokens')
      .select(['id', 'platform', 'device_name', 'created_at'])
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ tokens });
  });

  // GET /:id — Get single notification
  app.get('/:id', async (c) => {
    const tdb = reqDb(c, db);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    const notification = await tdb
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
    const tdb = reqDb(c, db);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    await tdb
      .updateTable('zv_notifications')
      .set({ is_read: true })
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ success: true });
  });

  // PATCH /:id/unread — Mark as unread
  app.patch('/:id/unread', async (c) => {
    const tdb = reqDb(c, db);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    await tdb
      .updateTable('zv_notifications')
      .set({ is_read: false })
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ success: true });
  });

  // POST /mark-all-read — Mark all as read for user
  app.post('/mark-all-read', async (c) => {
    const tdb = reqDb(c, db);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    await tdb
      .updateTable('zv_notifications')
      .set({ is_read: true })
      .where('user_id', '=', user.id)
      .where('is_read', '=', false)
      .execute();
    return c.json({ success: true });
  });

  // DELETE /clear-all — Clear all read notifications (must be before DELETE /:id to prevent route conflict)
  app.delete('/clear-all', async (c) => {
    const tdb = reqDb(c, db);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    await tdb
      .deleteFrom('zv_notifications')
      .where('user_id', '=', user.id)
      .where('is_read', '=', true)
      .execute();
    return c.json({ success: true });
  });

  // DELETE /:id — Delete notification
  app.delete('/:id', async (c) => {
    const tdb = reqDb(c, db);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    await tdb
      .deleteFrom('zv_notifications')
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ success: true });
  });

  // ── Web Push Subscriptions ────────────────────────────────────

  // GET /push/vapid-public-key — what the browser needs to subscribe.
  //
  // `applicationServerKey` in `pushManager.subscribe()`. Public by definition —
  // it is handed to every push service on every send — but the route stays
  // behind the session guard like the rest of this router, since only a
  // signed-in user has anything to subscribe for.
  app.get('/push/vapid-public-key', async (c) => {
    const config = getVapidConfig();
    if (!config) return c.json({ enabled: false, publicKey: null });
    return c.json({ enabled: true, publicKey: config.publicKey });
  });

  // POST /push/subscribe — Subscribe to web push
  app.post(
    '/push/subscribe',
    zValidator(
      'json',
      z.object({
        endpoint: z.string().url(),
        p256dh: z.string(),
        auth: z.string(),
        user_agent: z.string().optional(),
      }),
    ),
    async (c) => {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user') as any;
      const { endpoint, p256dh, auth: authKey, user_agent } = c.req.valid('json');

      // The endpoint is a URL the CLIENT chose and the server will later POST
      // to, so it is an SSRF sink — the same one webhooks have. `z.string().url()`
      // accepts `http://169.254.169.254/…` and `file:` alike. Refused at the
      // door as well as at send time: a stored endpoint is a sink that fires
      // later, on a schedule nobody is watching.
      try {
        validatePublicUrl(endpoint);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Invalid push endpoint' }, 400);
      }

      // The keys are fixed-size values from the Push API, not free text: 65
      // bytes for the P-256 point, 16 for the auth secret. Checked here so a
      // malformed subscription fails at subscribe time rather than silently
      // never receiving anything.
      if (!isValidP256dh(p256dh)) return c.json({ error: 'Invalid p256dh key' }, 400);
      if (!isValidAuthSecret(authKey)) return c.json({ error: 'Invalid auth secret' }, 400);

      const tdb = reqDb(c, db);
      // `endpoint` is unique across the table, and the conflict branch used to
      // set `user_id = EXCLUDED.user_id` — so posting someone else's endpoint
      // reassigned their subscription to the caller. The victim stops receiving
      // their own web push and the caller's notifications are delivered to the
      // victim's browser. An endpoint is a capability URL, not a claim of
      // ownership, so the update applies only to the row the caller already owns.
      const upserted = await sql<{ user_id: string }>`
        INSERT INTO zv_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
        VALUES (${user.id}, ${endpoint}, ${p256dh}, ${authKey}, ${user_agent ?? null})
        ON CONFLICT (endpoint) DO UPDATE SET
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth,
          user_agent = EXCLUDED.user_agent
        WHERE zv_push_subscriptions.user_id = ${user.id}
        RETURNING user_id
      `.execute(tdb);

      // No row: the endpoint exists and belongs to somebody else.
      if (upserted.rows.length === 0) {
        return c.json({ error: 'Endpoint already registered' }, 409);
      }

      return c.json({ success: true }, 201);
    },
  );

  // DELETE /push/subscribe — Unsubscribe
  app.delete('/push/subscribe', async (c) => {
    const tdb = reqDb(c, db);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    const { endpoint } = await c.req.json();
    await tdb
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
    zValidator(
      'json',
      z.object({
        user_id: z.union([z.string(), z.array(z.string())]).optional(), // omit = all users
        title: z.string().min(1).max(200),
        message: z.string().min(1).max(2000),
        type: z.enum(['info', 'success', 'warning', 'error']).default('info'),
        // `z.string().url()` is not the check it looks like: it accepts
        // `javascript:alert(1)` and `data:text/html,…`, because both are valid
        // URLs. The Studio renders this as the notification's link, so a tenant
        // admin could send every member of their tenant a click-to-execute
        // payload — and a notification from the platform is exactly the thing
        // people click without reading.
        action_url: z
          .string()
          .url()
          .refine(
            (u) => /^https?:\/\//i.test(u) || u.startsWith('/'),
            'action_url must be an http(s) URL or an in-app path',
          )
          .optional(),
      }),
    ),
    async (c) => {
      const tdb = reqDb(c, db);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user') as any;
      const isAdmin = await isTenantAdmin(user.id);
      if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);

      const { user_id, title, message, type, action_url } = c.req.valid('json');

      // Who this tenant's admin is allowed to notify.
      //
      // `user` is a global table with no tenant column, so selecting from it
      // returned every account on the instance: a tenant admin's "notify
      // everyone" reached every other tenant's users, and an explicit
      // `user_id` reached anyone whose id they could guess. Notifications
      // carry a title, a body and an `action_url` — enough to phish.
      //
      // The audience follows the same rule as the membership middleware:
      // enforced for a real tenant, and a no-op for the default one, where
      // every account belongs to the single tenant and no membership rows are
      // written. Anything else would make broadcast deliver to nobody on a
      // single-tenant install.
      const actingTenant = tenantId(c);
      const audience =
        actingTenant && actingTenant !== DEFAULT_TENANT_ID
          ? (
              await db
                .selectFrom('zv_tenant_users')
                .select('user_id')
                .where('tenant_id', '=', actingTenant)
                .execute()
            ).map((r) => r.user_id)
          : null; // null = the whole instance, which here is the whole tenant

      let targetIds: string[];
      if (user_id) {
        const requested = Array.isArray(user_id) ? user_id : [user_id];
        targetIds = audience ? requested.filter((id) => audience.includes(id)) : requested;
        if (targetIds.length === 0) {
          return c.json({ error: 'No recipients in this tenant' }, 400);
        }
      } else if (audience) {
        targetIds = audience;
      } else {
        // Broadcast to all active users
        const users = await tdb.selectFrom('user').select('id').execute();
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        targetIds = users.map((u: any) => u.id);
      }

      await sendNotification(tdb, {
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

  // ── Push Token Management ──────────────────────────────────────

  // POST /push-tokens — register a device token
  app.post(
    '/push-tokens',
    zValidator(
      'json',
      z.object({
        token: z.string().min(1).max(4096),
        platform: z.enum(['fcm', 'apns', 'web']),
        device_name: z.string().max(100).optional(),
      }),
    ),
    async (c) => {
      const tdb = reqDb(c, db);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user') as any;
      const { token, platform, device_name } = c.req.valid('json');

      // Conflict on `token` alone (migration 013). A device token identifies a
      // DEVICE, so at most one account may hold it: the pair constraint this
      // replaces left the token itself free, and the token arrives in the
      // request body, so one account could register a token belonging to
      // another and have its own notifications delivered to a device it does
      // not own.
      //
      // The newest registration wins, `user_id` included — an OS reissues a
      // token to whoever last signed in on that device, so the previous owner
      // is a session that has been replaced. That is also the residual risk: a
      // caller who KNOWS a token can take the device over, and the server
      // cannot tell them from the device itself. What it can do is make that a
      // takeover rather than a silent second owner — one the loser can see,
      // because the device leaves their `GET /push-tokens` list.
      await tdb
        .insertInto('zvd_push_tokens')
        .values({ user_id: user.id, token, platform, device_name: device_name ?? null })
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        .onConflict((oc: any) =>
          oc.columns(['token']).doUpdateSet({
            user_id: user.id,
            platform,
            device_name: device_name ?? null,
            updated_at: new Date(),
          }),
        )
        .execute();

      return c.json({ success: true });
    },
  );

  // DELETE /push-tokens/:id — unregister a token
  app.delete('/push-tokens/:id', async (c) => {
    const tdb = reqDb(c, db);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    await tdb
      .deleteFrom('zvd_push_tokens')
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id) // users can only delete their own tokens
      .execute();
    return c.json({ success: true });
  });

  return app;
}
