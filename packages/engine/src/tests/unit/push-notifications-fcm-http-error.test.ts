/**
 * push-notifications.ts — FCM HTTP error responses.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { sendPushToUser } from '../../lib/push-notifications.js';
import { CannedDb } from './fixtures/canned-db.js';

const TOKENS_RE = /select .* from "zvd_push_tokens"/i;

let originalFetch: typeof fetch;
let savedKey: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  savedKey = process.env.FCM_SERVER_KEY;
  process.env.FCM_SERVER_KEY = 'srv-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedKey === undefined) delete process.env.FCM_SERVER_KEY;
  else process.env.FCM_SERVER_KEY = savedKey;
});

describe('sendPushToUser — FCM HTTP errors', () => {
  it('counts failed and warns when FCM returns a non-2xx status', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    })) as unknown as typeof fetch;

    const db = new CannedDb();
    db.when(TOKENS_RE, [{ id: 't1', token: 'dev1', platform: 'fcm' }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
        title: 'a',
        body: 'b',
      });
      expect(res).toEqual({ sent: 0, failed: 1 });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[push:fcm] HTTP 500'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
