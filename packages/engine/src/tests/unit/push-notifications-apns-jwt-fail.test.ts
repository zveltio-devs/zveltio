/**
 * push-notifications.ts — APNS JWT generation failure + APNS network errors.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { sendPushToUser, _resetApnsJwtCacheForTests } from '../../lib/push-notifications.js';
import { CannedDb } from './fixtures/canned-db.js';

const TOKENS_RE = /select .* from "zvd_push_tokens"/i;

const ENV_KEYS = ['APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID'];
let savedEnv: Record<string, string | undefined>;
let originalFetch: typeof fetch;

beforeEach(() => {
  _resetApnsJwtCacheForTests();
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

describe('sendPushToUser — APNS failure paths', () => {
  it('counts failed when APNS JWT signing fails on invalid key material', async () => {
    process.env.APNS_KEY = '-----BEGIN PRIVATE KEY-----\nnot-valid-pem\n-----END PRIVATE KEY-----';
    process.env.APNS_KEY_ID = 'ABC1234567';
    process.env.APNS_TEAM_ID = 'TEAM123456';

    const db = new CannedDb();
    db.when(TOKENS_RE, [{ id: 't1', token: 'iosdev', platform: 'apns' }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
        title: 'a',
        body: 'b',
      });
      expect(res).toEqual({ sent: 0, failed: 1 });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('JWT generation failed'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('counts failed when the APNS HTTP request throws', async () => {
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

    globalThis.fetch = (async () => {
      throw new Error('apns network down');
    }) as unknown as typeof fetch;

    const db = new CannedDb();
    db.when(TOKENS_RE, [{ id: 't1', token: 'iosdev', platform: 'apns' }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
        title: 'a',
        body: 'b',
      });
      expect(res).toEqual({ sent: 0, failed: 1 });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[push:apns] request failed'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
