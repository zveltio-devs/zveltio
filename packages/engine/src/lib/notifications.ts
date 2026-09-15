/**
 * The notification sender — rows in `zv_notifications`, then push.
 *
 * ONE writer, deliberately. There were two: this file, reached by every
 * extension through `ctx.internals.sendNotification`, and a second copy in
 * `routes/notifications.ts` that grew the mobile-push call and later the
 * Web Push one. So an extension's notification was written to the database and
 * never left it, while the same notification raised by a flow reached a phone —
 * a difference nothing reported, because both paths "succeeded".
 *
 * `routes/notifications.ts` re-exports what is here.
 */

import type { Database } from '../db/index.js';
import { toJsonb } from './jsonb.js';
import { sendPushToUsers } from './push-notifications.js';
import { isWebPushConfigured, sendWebPushToUsers } from './web-push.js';

export interface NotificationInput {
  user_id: string;
  title: string;
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  action_url?: string;
  source?: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  metadata?: Record<string, any>;
}

/**
 * Push deliveries dispatched by `sendNotification`, still running.
 *
 * `sendNotification` returns as soon as the rows are written and does not wait
 * on FCM, APNS or a browser push service — the right behaviour, since a caller
 * writing a notification must not block on somebody else's HTTP endpoint. It
 * leaves a test with nothing to await, and `webhooks.ts` records where that
 * road goes: a 50ms sleep that failed at 52.27ms, then a 2s deadline that
 * failed at 2007ms. Each fix widened the window and kept the race.
 */
const _pushesInFlight = new Set<Promise<unknown>>();

/** Resolve once every push started so far has finished. Test-only. */
export async function _settleNotificationPushes(): Promise<void> {
  // A loop rather than one `Promise.all`: a send can start another, and
  // awaiting the first snapshot would return with the second still running.
  while (_pushesInFlight.size > 0) {
    await Promise.all([..._pushesInFlight]);
  }
}

/** Track a fire-and-forget push so `_settleNotificationPushes` can await it. */
function track(p: Promise<unknown>): void {
  _pushesInFlight.add(p);
  void p.finally(() => _pushesInFlight.delete(p));
}

// Helper to send a notification to one or more users
export async function sendNotification(
  // biome-ignore lint/suspicious/noExplicitAny: extensions pass their scoped db handle
  db: any,
  opts: {
    user_id: string | string[];
    title: string;
    message: string;
    type?: 'info' | 'success' | 'warning' | 'error';
    action_url?: string;
    source?: string;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // See lib/jsonb.ts. Measured on a live database before this: 12 of 12
    // rows held a jsonb string, so `metadata ? 'key'` was false and
    // `metadata->>'key'` NULL for every notification ever written.
    metadata: toJsonb(opts.metadata ?? {}),
  }));

  // Insert each notification individually so a single invalid user_id (FK miss,
  // deleted account) does not cause the entire batch to fail silently.
  // Promise.allSettled ensures all valid entries are delivered even if some fail.
  const results = await Promise.allSettled(
    values.map((v) => db.insertInto('zv_notifications').values(v).execute()),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    console.error(
      `[sendNotification] ${failed.length}/${values.length} notifications failed:`,
      (failed[0] as PromiseRejectedResult).reason,
    );
  }

  // Fire-and-forget mobile push — only if FCM or APNS are configured.
  // Push failures are common (stale tokens, FCM/APNS outages) so log at
  // warn level — escalation happens only when it's the same userId
  // failing repeatedly.
  if (process.env.FCM_SERVER_KEY || process.env.APNS_KEY) {
    track(
      sendPushToUsers(db, userIds, { title: opts.title, body: opts.message }).catch(
        (err: Error) => {
          console.warn(`[notifications] push to ${userIds.length} user(s) failed:`, err.message);
        },
      ),
    );
  }

  // Fire-and-forget browser push. Independent of FCM/APNS above: Web Push needs
  // no third-party account, which is the point of it on a self-hosted install,
  // so it is gated on its own VAPID keys alone. Until this existed,
  // `zv_push_subscriptions` had no reader at all — a browser that subscribed
  // was answered 201 and then heard nothing, for the life of the install.
  if (isWebPushConfigured()) {
    track(
      sendWebPushToUsers(db, userIds, {
        title: opts.title,
        body: opts.message,
        data: opts.action_url ? { url: opts.action_url } : undefined,
      }).catch((err: Error) => {
        console.warn(`[notifications] web push to ${userIds.length} user(s) failed:`, err.message);
      }),
    );
  }
}
