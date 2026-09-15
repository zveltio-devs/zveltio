/**
 * That `sendNotification` is WIRED to the web push sender.
 *
 * `sendWebPush` and `encryptPayload` have their own unit coverage, and all of
 * it stays green while nothing calls them — which is the state this section
 * found: `zv_push_subscriptions` had a writer, a deleter, and no reader at all,
 * so a browser that subscribed was answered 201 and then heard nothing for the
 * life of the install. A unit test of the sender cannot notice that. This one
 * writes a subscription, sends a notification, and counts what left the process.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { _settleNotificationPushes, sendNotification } from '../../routes/notifications.js';
// The path extensions are handed through `ctx.internals` — a second copy for a
// long time, and the copy that sent nothing.
import { sendNotification as extensionSendNotification } from '../../lib/notifications.js';

const d = harnessAvailable() ? describe : describe.skip;

// A real, matching P-256 pair: a mismatched one signs something a push service
// would reject, so the fixture has to be genuine even though fetch is stubbed.
const VAPID_PUBLIC =
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const VAPID_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH_SECRET = 'BTBZMqHH6r4Tts7J_aSIgg';

const STAMP = Date.now();
const ENDPOINT = `https://push.example.com/wiring-${STAMP}`;

d('sendNotification delivers web push (in-process)', () => {
  let db: Database;
  let userId = '';
  let originalFetch: typeof fetch;
  let posted: string[] = [];
  const envBefore = {
    pub: process.env.VAPID_PUBLIC_KEY,
    priv: process.env.VAPID_PRIVATE_KEY,
    sub: process.env.VAPID_SUBJECT,
  };

  /**
   * Resolve once the fire-and-forget send has finished — deterministically.
   *
   * A 50ms sleep here passed alone and failed in the full file, which is the
   * race `webhooks.ts` already paid for twice. Nothing is timed any more.
   */
  const settle = _settleNotificationPushes;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const row = await sql<{ id: string }>`
      SELECT id FROM "user" ORDER BY "createdAt" DESC LIMIT 1
    `.execute(db);
    userId = row.rows[0]!.id;

    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC;
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE;
    process.env.VAPID_SUBJECT = 'mailto:ops@example.com';

    await sql`
      INSERT INTO zv_push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (${userId}, ${ENDPOINT}, ${P256DH}, ${AUTH_SECRET})
    `.execute(db);
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  afterAll(async () => {
    // Restore rather than delete: another file in this process may rely on it.
    if (envBefore.pub === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = envBefore.pub;
    if (envBefore.priv === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = envBefore.priv;
    if (envBefore.sub === undefined) delete process.env.VAPID_SUBJECT;
    else process.env.VAPID_SUBJECT = envBefore.sub;

    if (!db) return;
    await sql`DELETE FROM zv_push_subscriptions WHERE endpoint LIKE ${`https://push.example.com/wiring-${STAMP}%`}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_notifications WHERE title = ${`wiring-${STAMP}`}`
      .execute(db)
      .catch(() => {});
  });

  function stub(status: number): void {
    originalFetch = globalThis.fetch;
    posted = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      posted.push(String(input));
      return { status, ok: status < 400, headers: new Headers(), text: async () => '' } as Response;
    }) as unknown as typeof fetch;
  }

  it('posts to the subscriber’s endpoint', async () => {
    stub(201);
    await sendNotification(db, {
      user_id: userId,
      title: `wiring-${STAMP}`,
      message: 'hello',
      action_url: '/intranet/notifications',
    });
    await settle();
    expect(posted).toContain(ENDPOINT);
  });

  it('delivers for an extension too, through ctx.internals', async () => {
    // `ctx.internals.sendNotification` is `lib/notifications.ts`. While that was
    // a separate copy it wrote the row and sent nothing, so an extension's
    // notification never reached a phone or a browser and nothing said so.
    stub(201);
    await extensionSendNotification(db, {
      user_id: userId,
      title: `wiring-${STAMP}`,
      message: 'from an extension',
    });
    await settle();
    expect(posted).toContain(ENDPOINT);
  });

  it('removes a subscription the push service says is gone', async () => {
    const gone = `${ENDPOINT}-gone`;
    await sql`
      INSERT INTO zv_push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (${userId}, ${gone}, ${P256DH}, ${AUTH_SECRET})
    `.execute(db);

    stub(410); // "this subscription is gone"
    await sendNotification(db, { user_id: userId, title: `wiring-${STAMP}`, message: 'x' });
    await settle();

    expect(posted).toContain(gone); // else the assertion below passes for free

    const left = await sql<{ endpoint: string }>`
      SELECT endpoint FROM zv_push_subscriptions WHERE endpoint = ${gone}
    `.execute(db);
    expect(left.rows).toHaveLength(0);
  });

  it('keeps a subscription when the failure is not about it', async () => {
    const kept = `${ENDPOINT}-kept`;
    await sql`
      INSERT INTO zv_push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (${userId}, ${kept}, ${P256DH}, ${AUTH_SECRET})
    `.execute(db);

    stub(500); // the push service is having a bad day; the browser is fine
    await sendNotification(db, { user_id: userId, title: `wiring-${STAMP}`, message: 'x' });
    await settle();

    expect(posted).toContain(kept); // else the assertion below passes for free

    const left = await sql<{ endpoint: string }>`
      SELECT endpoint FROM zv_push_subscriptions WHERE endpoint = ${kept}
    `.execute(db);
    expect(left.rows).toHaveLength(1);
  });
});
