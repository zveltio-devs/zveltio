/**
 * push-notifications.ts — stale-token cleanup must be scoped to an actual
 * invalid-token signal, not to "the send failed".
 *
 * sendPushToUser collapsed every failure reason (FCM 5xx, FCM auth error,
 * APNS 5xx, a network exception) into a single boolean and deleted the
 * device's zvd_push_tokens row whenever that boolean was false. A transient
 * FCM/APNS outage, or an expired FCM_SERVER_KEY, therefore purged every
 * push token it touched — an outage that heals on its own becomes a
 * permanent unsubscribe. Only a provider response that explicitly says the
 * token itself is dead (FCM NotRegistered/InvalidRegistration, APNS 410 /
 * BadDeviceToken) may delete the row.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { sendPushToUser } from '../../lib/push-notifications.js';
import { CannedDb } from './fixtures/canned-db.js';

const TOKENS_RE = /select .* from "zvd_push_tokens"/i;
const DELETE_RE = /delete from "zvd_push_tokens"/i;

let originalFetch: typeof fetch;
let responses: Array<{ ok?: boolean; status?: number; body?: unknown }>;

function stubFetch(): void {
  globalThis.fetch = (async () => {
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

describe('sendPushToUser — stale-token cleanup is scoped to an invalid-token signal', () => {
  it('does NOT delete the token on an FCM 500 (transient server error)', async () => {
    process.env.FCM_SERVER_KEY = 'srv-key';
    responses = [{ status: 500, ok: false, body: 'internal error' }];
    const db = dbWithTokens([{ id: 't1', token: 'dev1', platform: 'fcm' }]);
    const res = await sendPushToUser(db.kysely as unknown as Database, 'u1', {
      title: 'a',
      body: 'b',
    });
    expect(res).toEqual({ sent: 0, failed: 1 });
    await new Promise((r) => setTimeout(r, 25));
    expect(db.executed(DELETE_RE).length).toBe(0);
  });

  it('does NOT delete the token on an FCM 401 (bad/expired server key)', async () => {
    process.env.FCM_SERVER_KEY = 'srv-key';
    responses = [{ status: 401, ok: false, body: 'unauthorized' }];
    const db = dbWithTokens([{ id: 't1', token: 'dev1', platform: 'fcm' }]);
    await sendPushToUser(db.kysely as unknown as Database, 'u1', { title: 'a', body: 'b' });
    await new Promise((r) => setTimeout(r, 25));
    expect(db.executed(DELETE_RE).length).toBe(0);
  });

  it('does NOT delete the token when the fetch itself throws (network error)', async () => {
    process.env.FCM_SERVER_KEY = 'srv-key';
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const db = dbWithTokens([{ id: 't1', token: 'dev1', platform: 'fcm' }]);
    await sendPushToUser(db.kysely as unknown as Database, 'u1', { title: 'a', body: 'b' });
    await new Promise((r) => setTimeout(r, 25));
    expect(db.executed(DELETE_RE).length).toBe(0);
  });

  it('DOES delete the token on an FCM InvalidRegistration signal', async () => {
    process.env.FCM_SERVER_KEY = 'srv-key';
    responses = [
      { status: 200, body: { failure: 1, results: [{ error: 'InvalidRegistration' }] } },
    ];
    const db = dbWithTokens([{ id: 'stale-1', token: 'dead', platform: 'fcm' }]);
    await sendPushToUser(db.kysely as unknown as Database, 'u1', { title: 'a', body: 'b' });
    await new Promise((r) => setTimeout(r, 25));
    const deletes = db.executed(DELETE_RE);
    expect(deletes.length).toBe(1);
    expect(deletes[0].parameters).toContain('stale-1');
  });

  it('does NOT delete the token on an APNS 500 (transient server error)', async () => {
    process.env.APNS_KEY = await makeApnsKeyPem();
    process.env.APNS_KEY_ID = 'ABC1234567';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    process.env.APNS_BUNDLE_ID = 'com.example.app';
    responses = [{ status: 500, ok: false, body: { reason: 'InternalServerError' } }];
    const db = dbWithTokens([{ id: 't1', token: 'iosdev', platform: 'apns' }]);
    await sendPushToUser(db.kysely as unknown as Database, 'u1', { title: 'a', body: 'b' });
    await new Promise((r) => setTimeout(r, 25));
    expect(db.executed(DELETE_RE).length).toBe(0);
  });

  it('DOES delete the token on an APNS 410 Unregistered', async () => {
    process.env.APNS_KEY = await makeApnsKeyPem();
    process.env.APNS_KEY_ID = 'ABC1234567';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    process.env.APNS_BUNDLE_ID = 'com.example.app';
    responses = [{ status: 410, ok: false, body: { reason: 'Unregistered' } }];
    const db = dbWithTokens([{ id: 'stale-2', token: 'iosdev', platform: 'apns' }]);
    await sendPushToUser(db.kysely as unknown as Database, 'u1', { title: 'a', body: 'b' });
    await new Promise((r) => setTimeout(r, 25));
    const deletes = db.executed(DELETE_RE);
    expect(deletes.length).toBe(1);
    expect(deletes[0].parameters).toContain('stale-2');
  });

  it('DOES delete the token on an APNS 400 BadDeviceToken', async () => {
    process.env.APNS_KEY = await makeApnsKeyPem();
    process.env.APNS_KEY_ID = 'ABC1234567';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    process.env.APNS_BUNDLE_ID = 'com.example.app';
    responses = [{ status: 400, ok: false, body: { reason: 'BadDeviceToken' } }];
    const db = dbWithTokens([{ id: 'stale-3', token: 'iosdev', platform: 'apns' }]);
    await sendPushToUser(db.kysely as unknown as Database, 'u1', { title: 'a', body: 'b' });
    await new Promise((r) => setTimeout(r, 25));
    const deletes = db.executed(DELETE_RE);
    expect(deletes.length).toBe(1);
    expect(deletes[0].parameters).toContain('stale-3');
  });
});
