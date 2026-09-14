/**
 * Mobile push notifications — FCM (Android/Web) + APNS (iOS).
 *
 * Required env vars:
 *   FCM_SERVER_KEY   — Firebase Cloud Messaging legacy server key
 *   APNS_KEY         — PEM-encoded APNS auth key (ES256, p8 format)
 *   APNS_KEY_ID      — 10-char key ID from Apple Developer console
 *   APNS_TEAM_ID     — 10-char Apple Developer team ID
 *   APNS_BUNDLE_ID   — App bundle ID (e.g. com.example.app)
 *   APNS_PRODUCTION  — 'true' for production APNS, default is sandbox
 */

import type { Database } from '../db/index.js';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  badge?: number;
  sound?: string;
}

// ── FCM (Firebase Cloud Messaging legacy HTTP) ────────────────────────────────

/**
 * What the provider said, not merely whether it worked.
 *
 * `sendPushToUser` deletes the device's `zvd_push_tokens` row when a send
 * fails. A boolean cannot say WHY it failed, so every reason collapsed into
 * "delete the token": an FCM 5xx, an expired `FCM_SERVER_KEY`, a network blip
 * — each one permanently unsubscribed every device it touched. An outage that
 * heals on its own left the tokens gone.
 *
 * Only the provider saying the TOKEN is dead may remove it.
 */
type PushVerdict = 'sent' | 'invalid-token' | 'failed';

/** FCM error codes that mean the registration itself is gone. */
const FCM_DEAD_TOKEN = new Set(['NotRegistered', 'InvalidRegistration']);

/** APNS `reason` values that mean the device token itself is unusable. */
const APNS_DEAD_TOKEN = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic']);

async function sendFcm(token: string, payload: PushPayload): Promise<PushVerdict> {
  const key = process.env.FCM_SERVER_KEY;
  if (!key) return 'failed';

  try {
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `key=${key}`,
      },
      body: JSON.stringify({
        to: token,
        notification: {
          title: payload.title,
          body: payload.body,
          sound: payload.sound ?? 'default',
        },
        data: payload.data ?? {},
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Transport- or auth-level: says nothing about this token.
      console.warn(`[push:fcm] HTTP ${res.status}: ${await res.text()}`);
      return 'failed';
    }
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const json = (await res.json()) as any;
    if (json.failure > 0) {
      const reason = json.results?.[0]?.error;
      console.warn('[push:fcm] delivery failure:', json.results?.[0]);
      return FCM_DEAD_TOKEN.has(reason) ? 'invalid-token' : 'failed';
    }
    return 'sent';
  } catch (err) {
    console.warn('[push:fcm] request failed:', err);
    return 'failed';
  }
}

// ── APNS (Apple Push Notification Service) — token-based auth ────────────────

let _apnsJwt: { token: string; issuedAt: number } | null = null;

async function getApnsJwt(): Promise<string | null> {
  const keyPem = process.env.APNS_KEY;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  if (!keyPem || !keyId || !teamId) return null;

  const now = Math.floor(Date.now() / 1000);
  // Reuse token for up to 55 minutes (APNS tokens valid for 1 hour)
  if (_apnsJwt && now - _apnsJwt.issuedAt < 55 * 60) return _apnsJwt.token;

  try {
    const header = { alg: 'ES256', kid: keyId };
    const claims = { iss: teamId, iat: now };
    const encode = (obj: object) =>
      btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const signingInput = `${encode(header)}.${encode(claims)}`;

    // Import APNS private key (ES256 / P-256)
    const pemBody = keyPem
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s/g, '');
    const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

    const key = await crypto.subtle.importKey(
      'pkcs8',
      der.buffer as ArrayBuffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(signingInput),
    );
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const token = `${signingInput}.${sig}`;
    _apnsJwt = { token, issuedAt: now };
    return token;
  } catch (err) {
    console.warn('[push:apns] JWT generation failed:', err);
    return null;
  }
}

async function sendApns(token: string, payload: PushPayload): Promise<PushVerdict> {
  const jwt = await getApnsJwt();
  // Our configuration, not the device's token: never a reason to unsubscribe it.
  if (!jwt) return 'failed';

  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!bundleId) {
    console.warn('[push:apns] APNS_BUNDLE_ID not set');
    return 'failed';
  }

  const host =
    process.env.APNS_PRODUCTION === 'true' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';

  try {
    const res = await fetch(`https://${host}/3/device/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `bearer ${jwt}`,
        'apns-topic': bundleId,
        'apns-push-type': 'alert',
      },
      body: JSON.stringify({
        aps: {
          alert: { title: payload.title, body: payload.body },
          badge: payload.badge,
          sound: payload.sound ?? 'default',
        },
        ...payload.data,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const err = (await res.json().catch(() => ({}))) as any;
      const reason = err.reason as string | undefined;
      console.warn(`[push:apns] HTTP ${res.status}: ${reason ?? 'unknown'}`);
      // 410 is Apple's "this token is gone"; the 4xx reasons say the same in
      // words. Everything else — 5xx, throttling, a bad JWT — is about us.
      return res.status === 410 || (reason !== undefined && APNS_DEAD_TOKEN.has(reason))
        ? 'invalid-token'
        : 'failed';
    }
    return 'sent';
  } catch (err) {
    console.warn('[push:apns] request failed:', err);
    return 'failed';
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendPushToUser(
  db: Database,
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> {
  const tokens = (await db
    .selectFrom('zvd_push_tokens')
    .select(['id', 'token', 'platform'])
    .where('user_id', '=', userId)
    .execute()) as { id: string; token: string; platform: string }[];

  if (tokens.length === 0) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  const staleTokens: string[] = [];

  await Promise.allSettled(
    tokens.map(async ({ id, token, platform }) => {
      let verdict: PushVerdict = 'failed';
      if (platform === 'fcm' || platform === 'web') {
        verdict = await sendFcm(token, payload);
      } else if (platform === 'apns') {
        verdict = await sendApns(token, payload);
      }
      if (verdict === 'sent') {
        sent++;
      } else {
        failed++;
        // Only when the provider says the TOKEN is dead. The comment here used
        // to claim this, while the code deleted on every failure — so an FCM
        // 5xx, an expired server key or a network blip unsubscribed every
        // device it touched, permanently.
        if (verdict === 'invalid-token') staleTokens.push(id);
      }
    }),
  );

  // Remove stale tokens (e.g. app uninstalled) — non-blocking.
  // Repeated failure here means we keep re-sending to dead tokens,
  // burning FCM/APNS quota — log so the trend is visible.
  if (staleTokens.length > 0) {
    db.deleteFrom('zvd_push_tokens')
      .where('id', 'in', staleTokens)
      .execute()
      .catch((err: Error) => {
        console.warn(
          `[push-notifications] stale-token cleanup (${staleTokens.length}) failed:`,
          err.message,
        );
      });
  }

  return { sent, failed };
}

export async function sendPushToUsers(
  db: Database,
  userIds: string[],
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> {
  const results = await Promise.allSettled(userIds.map((uid) => sendPushToUser(db, uid, payload)));
  return results.reduce(
    (acc, r) => {
      if (r.status === 'fulfilled') {
        acc.sent += r.value.sent;
        acc.failed += r.value.failed;
      }
      return acc;
    },
    { sent: 0, failed: 0 },
  );
}

/** Test-only — never import outside src/tests/. */
export function _resetApnsJwtCacheForTests(): void {
  _apnsJwt = null;
}
