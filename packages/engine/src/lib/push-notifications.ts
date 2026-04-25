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

async function sendFcm(token: string, payload: PushPayload): Promise<boolean> {
  const key = process.env.FCM_SERVER_KEY;
  if (!key) return false;

  try {
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `key=${key}`,
      },
      body: JSON.stringify({
        to: token,
        notification: { title: payload.title, body: payload.body, sound: payload.sound ?? 'default' },
        data: payload.data ?? {},
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[push:fcm] HTTP ${res.status}: ${await res.text()}`);
      return false;
    }
    const json = await res.json() as any;
    if (json.failure > 0) {
      console.warn('[push:fcm] delivery failure:', json.results?.[0]);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[push:fcm] request failed:', err);
    return false;
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
      'pkcs8', der.buffer as ArrayBuffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['sign'],
    );
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(signingInput),
    );
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const token = `${signingInput}.${sig}`;
    _apnsJwt = { token, issuedAt: now };
    return token;
  } catch (err) {
    console.warn('[push:apns] JWT generation failed:', err);
    return null;
  }
}

async function sendApns(token: string, payload: PushPayload): Promise<boolean> {
  const jwt = await getApnsJwt();
  if (!jwt) return false;

  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!bundleId) {
    console.warn('[push:apns] APNS_BUNDLE_ID not set');
    return false;
  }

  const host = process.env.APNS_PRODUCTION === 'true'
    ? 'api.push.apple.com'
    : 'api.sandbox.push.apple.com';

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
      const err = await res.json().catch(() => ({})) as any;
      console.warn(`[push:apns] HTTP ${res.status}: ${err.reason ?? 'unknown'}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[push:apns] request failed:', err);
    return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendPushToUser(
  db: Database,
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> {
  const tokens = await (db as any)
    .selectFrom('zvd_push_tokens')
    .select(['id', 'token', 'platform'])
    .where('user_id', '=', userId)
    .execute() as { id: string; token: string; platform: string }[];

  if (tokens.length === 0) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  const staleTokens: string[] = [];

  await Promise.allSettled(
    tokens.map(async ({ id, token, platform }) => {
      let ok = false;
      if (platform === 'fcm' || platform === 'web') {
        ok = await sendFcm(token, payload);
      } else if (platform === 'apns') {
        ok = await sendApns(token, payload);
      }
      if (ok) {
        sent++;
      } else {
        failed++;
        // Mark for cleanup if FCM reports invalid token
        staleTokens.push(id);
      }
    }),
  );

  // Remove stale tokens (e.g. app uninstalled) — non-blocking
  if (staleTokens.length > 0) {
    (db as any)
      .deleteFrom('zvd_push_tokens')
      .where('id', 'in', staleTokens)
      .execute()
      .catch(() => { /* non-critical */ });
  }

  return { sent, failed };
}

export async function sendPushToUsers(
  db: Database,
  userIds: string[],
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> {
  const results = await Promise.allSettled(
    userIds.map((uid) => sendPushToUser(db, uid, payload)),
  );
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
