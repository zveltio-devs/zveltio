/**
 * APNS JWT cache + missing bundle id (lib/push-notifications.ts).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { sendPushToUser } from '../../lib/push-notifications.js';
import { CannedDb } from './fixtures/canned-db.js';

const TOKENS_RE = /select .* from "zvd_push_tokens"/i;

let originalFetch: typeof fetch;
let fetchCalls: { url: string; init?: RequestInit }[];
let responses: Array<{ ok?: boolean; status?: number; body?: unknown }>;

const ENV_KEYS = [
  'FCM_SERVER_KEY',
  'APNS_KEY',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'APNS_PRODUCTION',
];
let savedEnv: Record<string, string | undefined>;

async function makeApnsKeyPem(): Promise<string> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

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

describe('sendPushToUser — APNS JWT cache', () => {
  it('reuses the same bearer token across consecutive APNS sends', async () => {
    process.env.APNS_KEY = await makeApnsKeyPem();
    process.env.APNS_KEY_ID = 'ABC1234567';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    process.env.APNS_BUNDLE_ID = 'com.example.app';
    responses = [{ status: 200 }, { status: 200 }];

    const db = new CannedDb();
    db.when(TOKENS_RE, [{ id: 't1', token: 'ios-1', platform: 'apns' }]);

    await sendPushToUser(db.kysely as unknown as Database, 'u1', { title: 'one', body: 'a' });
    await sendPushToUser(db.kysely as unknown as Database, 'u1', { title: 'two', body: 'b' });

    expect(fetchCalls.length).toBe(2);
    const auth1 = (fetchCalls[0].init?.headers as Record<string, string>).Authorization;
    const auth2 = (fetchCalls[1].init?.headers as Record<string, string>).Authorization;
    expect(auth1).toBe(auth2);
    expect(auth1).toMatch(/^bearer /);
  });

  it('counts APNS delivery failed when APNS_BUNDLE_ID is unset', async () => {
    process.env.APNS_KEY = await makeApnsKeyPem();
    process.env.APNS_KEY_ID = 'ABC1234567';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    // APNS_BUNDLE_ID intentionally unset

    const db = new CannedDb();
    db.when(TOKENS_RE, [{ id: 't1', token: 'iosdev', platform: 'apns' }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
        title: 'a',
        body: 'b',
      });
      expect(res).toEqual({ sent: 0, failed: 1 });
      expect(fetchCalls.length).toBe(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('APNS_BUNDLE_ID'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
