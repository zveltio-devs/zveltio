/**
 * push-notifications.ts — APNS non-200 HTTP responses.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { sendPushToUser } from '../../lib/push-notifications.js';
import { CannedDb } from './fixtures/canned-db.js';

const TOKENS_RE = /select .* from "zvd_push_tokens"/i;

const ENV_KEYS = ['APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID'];
let savedEnv: Record<string, string | undefined>;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('sendPushToUser — APNS HTTP error responses', () => {
  it('counts failed and logs when APNS returns a non-200 status', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
    process.env.APNS_KEY = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
    process.env.APNS_KEY_ID = 'ABC1234567';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    process.env.APNS_BUNDLE_ID = 'com.example.app';

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), {
        status: 410,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    const db = new CannedDb();
    db.when(TOKENS_RE, [{ id: 't1', token: 'iosdev', platform: 'apns' }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
        title: 'a',
        body: 'b',
      });
      expect(res).toEqual({ sent: 0, failed: 1 });
      expect(
        warn.mock.calls.some(
          (c) =>
            String(c[0]).includes('[push:apns] HTTP 410') &&
            String(c[0]).includes('BadDeviceToken'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
