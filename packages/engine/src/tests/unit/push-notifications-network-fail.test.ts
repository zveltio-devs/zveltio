/**
 * push-notifications.ts — FCM network failure + stale-token cleanup resilience.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { sendPushToUser } from '../../lib/push-notifications.js';
import { CannedDb } from './fixtures/canned-db.js';

const TOKENS_RE = /select .* from "zvd_push_tokens"/i;
const DELETE_RE = /delete from "zvd_push_tokens"/i;

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

describe('sendPushToUser — network + cleanup failures', () => {
  it('counts FCM delivery failed when fetch throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const db = new CannedDb();
    db.when(TOKENS_RE, [{ id: 't1', token: 'dev1', platform: 'fcm' }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
        title: 'a',
        body: 'b',
      });
      expect(res).toEqual({ sent: 0, failed: 1 });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[push:fcm] request failed'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when stale-token cleanup DELETE fails', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ failure: 1, results: [{ error: 'NotRegistered' }] }),
    })) as unknown as typeof fetch;

    const db = new CannedDb();
    db.when(TOKENS_RE, [{ id: 'stale-1', token: 'dead', platform: 'fcm' }]);
    db.fail(DELETE_RE, new Error('db offline'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
        title: 'a',
        body: 'b',
      });
      expect(res).toEqual({ sent: 0, failed: 1 });
      await new Promise((r) => setTimeout(r, 25));
      expect(warn.mock.calls.some((c) => String(c[0]).includes('stale-token cleanup'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
