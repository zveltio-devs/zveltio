/**
 * Unit coverage for mobile push (FCM + APNS).
 *
 * The public API (sendPushToUser / sendPushToUsers) reads push tokens from the
 * DB then fans out to FCM (Android/Web) or APNS (iOS). We drive it with:
 *   - CannedDb: answers the `zvd_push_tokens` SELECT and records the stale-token
 *     DELETE, no Postgres.
 *   - a stubbed globalThis.fetch: scripts the FCM/APNS HTTP responses.
 *   - a REAL ES256 key generated in-test so the APNS JWT signing path actually
 *     executes (crypto.subtle.importKey/sign), not just the env-missing guard.
 *
 * No network, no DB, no Apple/Firebase credentials.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { sendPushToUser, sendPushToUsers } from '../../lib/push-notifications.js';
import { CannedDb } from './fixtures/canned-db.js';

const TOKENS_RE = /select .* from "zvd_push_tokens"/i;
const DELETE_RE = /delete from "zvd_push_tokens"/i;

let originalFetch: typeof fetch;
let fetchCalls: { url: string; init?: RequestInit }[];

/** Queue of scripted responses consumed in order; falls back to 200 {} */
let responses: Array<{ ok?: boolean; status?: number; body?: unknown }>;

function stubFetch(): void {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    const r = responses.shift() ?? { status: 200, body: {} };
    const status = r.status ?? 200;
    return {
      ok: r.ok ?? status < 400,
      status,
      json: async () => r.body ?? {},
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    } as Response;
  }) as unknown as typeof fetch;
}

/** Generate a real P-256 private key in PEM (pkcs8) so getApnsJwt can sign. */
async function makeApnsKeyPem(): Promise<string> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

const ENV_KEYS = [
  'FCM_SERVER_KEY',
  'APNS_KEY',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'APNS_PRODUCTION',
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  responses = [];
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function dbWithTokens(rows: { id: string; token: string; platform: string }[]): CannedDb {
  const db = new CannedDb();
  db.when(TOKENS_RE, rows);
  db.when(DELETE_RE, []);
  return db;
}

describe('sendPushToUser', () => {
  it('returns zero counts when the user has no tokens', async () => {
    const db = dbWithTokens([]);
    const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
      title: 'hi',
      body: 'there',
    });
    expect(res).toEqual({ sent: 0, failed: 0 });
    expect(fetchCalls.length).toBe(0);
  });

  it('delivers to an FCM token and counts it sent', async () => {
    process.env.FCM_SERVER_KEY = 'srv-key';
    responses = [{ status: 200, body: { failure: 0 } }];
    const db = dbWithTokens([{ id: 't1', token: 'dev1', platform: 'fcm' }]);
    const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
      title: 'hi',
      body: 'b',
    });
    expect(res).toEqual({ sent: 1, failed: 0 });
    expect(fetchCalls[0].url).toBe('https://fcm.googleapis.com/fcm/send');
    expect((fetchCalls[0].init?.headers as Record<string, string>).Authorization).toBe(
      'key=srv-key',
    );
  });

  it('routes the "web" platform to FCM as well', async () => {
    process.env.FCM_SERVER_KEY = 'srv-key';
    responses = [{ status: 200, body: {} }];
    const db = dbWithTokens([{ id: 't1', token: 'w1', platform: 'web' }]);
    const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
      title: 'a',
      body: 'b',
    });
    expect(res.sent).toBe(1);
    expect(fetchCalls[0].url).toContain('fcm.googleapis.com');
  });

  it('counts a token failed and schedules stale-token cleanup on FCM delivery failure', async () => {
    process.env.FCM_SERVER_KEY = 'srv-key';
    responses = [{ status: 200, body: { failure: 1, results: [{ error: 'NotRegistered' }] } }];
    const db = dbWithTokens([{ id: 'stale-1', token: 'dead', platform: 'fcm' }]);
    const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
      title: 'a',
      body: 'b',
    });
    expect(res).toEqual({ sent: 0, failed: 1 });
    // stale-token DELETE is fire-and-forget — let the microtask/timer flush.
    await new Promise((r) => setTimeout(r, 25));
    const deletes = db.executed(DELETE_RE);
    expect(deletes.length).toBe(1);
    expect(deletes[0].parameters).toContain('stale-1');
  });

  it('treats a missing FCM_SERVER_KEY as a failed send', async () => {
    // FCM_SERVER_KEY intentionally unset
    const db = dbWithTokens([{ id: 't1', token: 'dev1', platform: 'fcm' }]);
    const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
      title: 'a',
      body: 'b',
    });
    expect(res).toEqual({ sent: 0, failed: 1 });
    expect(fetchCalls.length).toBe(0); // never reached the network
  });

  it('counts an FCM HTTP error as failed', async () => {
    process.env.FCM_SERVER_KEY = 'srv-key';
    responses = [{ status: 401, ok: false, body: 'unauthorized' }];
    const db = dbWithTokens([{ id: 't1', token: 'dev1', platform: 'fcm' }]);
    const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
      title: 'a',
      body: 'b',
    });
    expect(res.failed).toBe(1);
  });

  it('signs an APNS JWT and delivers to an apns token', async () => {
    process.env.APNS_KEY = await makeApnsKeyPem();
    process.env.APNS_KEY_ID = 'ABC1234567';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    process.env.APNS_BUNDLE_ID = 'com.example.app';
    process.env.APNS_PRODUCTION = 'true';
    responses = [{ status: 200, body: {} }];
    const db = dbWithTokens([{ id: 't1', token: 'iosdev', platform: 'apns' }]);
    const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
      title: 'a',
      body: 'b',
      badge: 3,
    });
    expect(res.sent).toBe(1);
    expect(fetchCalls[0].url).toBe('https://api.push.apple.com/3/device/iosdev');
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^bearer /);
    expect(headers['apns-topic']).toBe('com.example.app');
  });

  it('fails an apns send when APNS env is not configured', async () => {
    // no APNS_* env → getApnsJwt returns null
    const db = dbWithTokens([{ id: 't1', token: 'iosdev', platform: 'apns' }]);
    const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
      title: 'a',
      body: 'b',
    });
    expect(res).toEqual({ sent: 0, failed: 1 });
    expect(fetchCalls.length).toBe(0);
  });

  it('counts an APNS non-200 response as failed', async () => {
    process.env.APNS_KEY = await makeApnsKeyPem();
    process.env.APNS_KEY_ID = 'ABC1234567';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    process.env.APNS_BUNDLE_ID = 'com.example.app';
    responses = [{ status: 410, ok: false, body: { reason: 'Unregistered' } }];
    const db = dbWithTokens([{ id: 't1', token: 'iosdev', platform: 'apns' }]);
    const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
      title: 'a',
      body: 'b',
    });
    expect(res.failed).toBe(1);
    // sandbox host by default (APNS_PRODUCTION unset)
    expect(fetchCalls[0].url).toContain('api.sandbox.push.apple.com');
  });
});

describe('sendPushToUsers', () => {
  it('aggregates sent/failed counts across multiple users', async () => {
    process.env.FCM_SERVER_KEY = 'srv-key';
    // u1 → 1 token OK, u2 → 1 token OK
    responses = [
      { status: 200, body: {} },
      { status: 200, body: {} },
    ];
    const db = new CannedDb();
    db.when(TOKENS_RE, [{ id: 't', token: 'dev', platform: 'fcm' }]);
    db.when(DELETE_RE, []);
    const res = await sendPushToUsers(db.kysely as unknown as Database, ['u1', 'u2'], {
      title: 'a',
      body: 'b',
    });
    expect(res).toEqual({ sent: 2, failed: 0 });
  });
});
