/**
 * Web Push — RFC 8291 (message encryption) and RFC 8292 (VAPID).
 *
 * The browser's own notification channel: a Service Worker gets the message
 * with the tab closed, and nothing about it is Google's. The subscription's
 * `endpoint` names the push service the BROWSER chose — Mozilla's for Firefox,
 * Apple's for Safari, Google's for Chrome — and the payload is encrypted
 * end-to-end with keys that service never has, so it forwards bytes it cannot
 * read. That is what makes this the only browser-notification path a
 * self-hosted install can offer without handing a third party a project and a
 * key, which is why `FCM_SERVER_KEY` — Google's retired legacy API — is not an
 * answer for an intranet.
 *
 * Two independent pieces of cryptography, which is also the order to read them:
 *
 *   VAPID (RFC 8292) says WHO is sending. A P-256 keypair generated once per
 *   install; each request carries a JWT signed with the private half and the
 *   public half beside it. No registration anywhere — that is the whole point
 *   of the scheme. Same shape as the APNS JWT in `push-notifications.ts`.
 *
 *   aes128gcm (RFC 8291) hides WHAT is sent, from the push service. ECDH
 *   between an ephemeral server key and the subscription's `p256dh`, mixed with
 *   the subscription's `auth` secret through HKDF, then AES-GCM.
 *
 * Required env — all three, or the sender stays off and says so once:
 *   VAPID_PUBLIC_KEY   — base64url, 65 bytes (uncompressed P-256 point)
 *   VAPID_PRIVATE_KEY  — base64url, 32 bytes (the raw scalar)
 *   VAPID_SUBJECT      — `mailto:` or `https:` URL identifying the operator
 *
 * `generateVapidKeys()` mints a pair in the shape these expect.
 */

import { validatePublicUrl, safeFetch } from './edge-functions/safe-fetch.js';
import type { Database } from '../db/index.js';

// ── base64url ────────────────────────────────────────────────────────────────

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function bytesToB64url(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ── HKDF (RFC 5869), the two halves separately ───────────────────────────────
//
// `crypto.subtle.deriveBits({name:'HKDF'})` does extract+expand in one call, but
// RFC 8291 needs the intermediate PRK — it extracts twice with different salts —
// so the halves are spelled out. Both are plain HMAC-SHA256.

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}

/** HKDF-Extract: a salted HMAC over the input keying material. */
const hkdfExtract = (salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> => hmac(salt, ikm);

/** HKDF-Expand for one block only — every output here is at most 32 bytes. */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  if (length > 32) throw new Error('[web-push] hkdfExpand: one block only');
  const block = await hmac(prk, concat(info, Uint8Array.of(1)));
  return block.slice(0, length);
}

// ── keys ─────────────────────────────────────────────────────────────────────

/**
 * A VAPID keypair in the shape the env vars expect.
 *
 * Exported because an operator has to get one somewhere, and the alternative is
 * telling them to install a Node library to produce two strings.
 */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (!jwk.d) throw new Error('[web-push] generated key has no private scalar');
  return { publicKey: bytesToB64url(pub), privateKey: jwk.d };
}

/**
 * Import the raw VAPID private scalar for signing.
 *
 * WebCrypto will not take a raw private key, so it is reassembled as a JWK: `d`
 * is the scalar from the env var, and `x`/`y` are the halves of the public
 * point. They must be the two halves of ONE key — a mismatched pair imports
 * without complaint on some implementations and produces signatures the push
 * service rejects, so this checks rather than trusts.
 */
async function importVapidKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const pub = b64urlToBytes(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('[web-push] VAPID_PUBLIC_KEY must be 65 bytes, uncompressed (0x04 prefix)');
  }
  const d = b64urlToBytes(privateKey);
  if (d.length !== 32) throw new Error('[web-push] VAPID_PRIVATE_KEY must be a 32-byte scalar');
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      d: bytesToB64url(d),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

// ── RFC 8292: the Authorization header ───────────────────────────────────────

/**
 * `vapid t=<jwt>, k=<public key>`.
 *
 * `aud` is the ORIGIN of the endpoint, not the endpoint — a JWT scoped to the
 * full URL is rejected. `exp` is capped at 24h by the spec; 12h leaves room for
 * a clock that disagrees.
 */
async function vapidAuthorization(
  endpoint: string,
  publicKey: string,
  privateKey: string,
  subject: string,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(
    utf8(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: subject })),
  );
  const signingInput = `${header}.${claims}`;
  const key = await importVapidKey(publicKey, privateKey);
  // ECDSA through WebCrypto is already the raw r||s pair JOSE wants; DER would
  // have to be unwrapped first.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      utf8(signingInput) as BufferSource,
    ),
  );
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${publicKey}`;
}

// ── RFC 8291: the encrypted body ─────────────────────────────────────────────

/** The single record this sends: 4096 bytes, so payloads stay under one. */
const RECORD_SIZE = 4096;

/** Padding delimiter for the last (only) record — RFC 8188 §2. */
const LAST_RECORD = 0x02;

/**
 * Encrypt one message for one subscription.
 *
 * `salt` and `serverKeys` are parameters rather than locals so the RFC's test
 * vector can be reproduced exactly; production passes neither. Injected by
 * default value, not `mock.module`, which is process-global in bun test and
 * leaks across files.
 */
export async function encryptPayload(
  plaintext: string,
  p256dh: string,
  auth: string,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
  serverKeys?: CryptoKeyPair,
): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('[web-push] p256dh must be 65 bytes, uncompressed (0x04 prefix)');
  }

  const keys =
    serverKeys ??
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, keys.privateKey, 256),
  );

  // RFC 8291 §3.3 — the first extraction is salted with the subscription's
  // auth secret, and the info string binds BOTH public keys into the result, so
  // a key swapped in transit produces a different IKM rather than a readable
  // message.
  const prkKey = await hkdfExtract(authSecret, ecdhSecret);
  const keyInfo = concat(utf8('WebPush: info'), Uint8Array.of(0), uaPublic, asPublic);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // RFC 8188 §2.2 — the second extraction is salted with the random salt that
  // travels in the header, which is what makes two sends of the same message
  // different ciphertexts.
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ]);
  const padded = concat(utf8(plaintext), Uint8Array.of(LAST_RECORD));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 },
      aesKey,
      padded as BufferSource,
    ),
  );

  // aes128gcm header: salt(16) | record size(4, big-endian) | idlen(1) | keyid
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, rs, Uint8Array.of(asPublic.length), asPublic, ciphertext);
}

// ── sending ──────────────────────────────────────────────────────────────────

export interface WebPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * What the push service said, not merely whether it worked.
 *
 * The same distinction `push-notifications.ts` had to learn: only the service
 * saying the SUBSCRIPTION is gone may remove it. A 500 from Mozilla, an expired
 * key or a network blip must not unsubscribe anybody.
 */
export type WebPushVerdict = 'sent' | 'expired' | 'failed' | 'not-configured';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** Configured, or null with one explanation. Read from env at call time. */
export function getVapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export function isWebPushConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getVapidConfig(env) !== null;
}

/**
 * Deliver one notification to one subscription.
 *
 * The endpoint is a URL the CLIENT supplied, so it is an SSRF sink like any
 * webhook URL: it goes through `validatePublicUrl` and `safeFetch`, which also
 * re-validates redirect targets. A subscription pointing at 169.254.169.254 is
 * refused here rather than fetched.
 */
export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: { title: string; body: string; data?: Record<string, unknown> },
  opts: { ttlSeconds?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {},
  config: VapidConfig | null = getVapidConfig(),
): Promise<WebPushVerdict> {
  if (!config) return 'not-configured';

  try {
    validatePublicUrl(subscription.endpoint);
  } catch (err) {
    console.warn('[web-push] refusing a subscription endpoint:', (err as Error).message);
    return 'failed';
  }

  try {
    const body = await encryptPayload(
      JSON.stringify(payload),
      subscription.p256dh,
      subscription.auth,
    );
    const authorization = await vapidAuthorization(
      subscription.endpoint,
      config.publicKey,
      config.privateKey,
      config.subject,
    );

    const res = await safeFetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttlSeconds ?? 86_400),
        Urgency: opts.urgency ?? 'normal',
      },
      body: body as BodyInit,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) return 'sent';
    // 404/410 are the push service saying this subscription is gone — the only
    // answer that may remove it. Everything else is about us or the service.
    if (res.status === 404 || res.status === 410) return 'expired';
    console.warn(
      `[web-push] HTTP ${res.status} from ${new URL(subscription.endpoint).host}:`,
      (await res.text().catch(() => '')).slice(0, 200),
    );
    return 'failed';
  } catch (err) {
    console.warn('[web-push] request failed:', (err as Error).message);
    return 'failed';
  }
}

/**
 * Deliver to every web push subscription of the given users.
 *
 * Mirrors `sendPushToUsers`: concurrent, never throws at the caller, and
 * removes a subscription ONLY when the push service said it is gone. A 500 from
 * one service must not unsubscribe a browser that is simply behind an outage.
 */
export async function sendWebPushToUsers(
  db: Database,
  userIds: string[],
  payload: { title: string; body: string; data?: Record<string, unknown> },
): Promise<{ sent: number; failed: number; expired: number }> {
  const config = getVapidConfig();
  if (!config || userIds.length === 0) return { sent: 0, failed: 0, expired: 0 };

  const subs = await db
    .selectFrom('zv_push_subscriptions')
    .select(['id', 'endpoint', 'p256dh', 'auth'])
    .where('user_id', 'in', userIds)
    .execute();
  if (subs.length === 0) return { sent: 0, failed: 0, expired: 0 };

  let sent = 0;
  let failed = 0;
  const gone: string[] = [];

  await Promise.allSettled(
    subs.map(async (s) => {
      const verdict = await sendWebPush(
        { endpoint: s.endpoint as string, p256dh: s.p256dh as string, auth: s.auth as string },
        payload,
        {},
        config,
      );
      if (verdict === 'sent') sent++;
      else if (verdict === 'expired') gone.push(s.id as string);
      else failed++;
    }),
  );

  if (gone.length > 0) {
    await db
      .deleteFrom('zv_push_subscriptions')
      .where('id', 'in', gone)
      .execute()
      .catch((err: Error) => {
        console.warn(
          `[web-push] could not remove ${gone.length} expired subscription(s):`,
          err.message,
        );
      });
  }

  return { sent, failed, expired: gone.length };
}

/** A `p256dh` from the Push API: 65 bytes, uncompressed point. */
export function isValidP256dh(value: string): boolean {
  try {
    const b = b64urlToBytes(value);
    return b.length === 65 && b[0] === 0x04;
  } catch {
    return false;
  }
}

/** An `auth` secret from the Push API: 16 bytes (RFC 8291 §3.2). */
export function isValidAuthSecret(value: string): boolean {
  try {
    return b64urlToBytes(value).length === 16;
  } catch {
    return false;
  }
}
