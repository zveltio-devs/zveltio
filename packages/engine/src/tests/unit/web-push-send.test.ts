/**
 * The transport half of Web Push: the VAPID header, the SSRF guard on the
 * client-supplied endpoint, and which answers may unsubscribe a browser.
 *
 * `fetch` is stubbed by assignment rather than `mock.module`, which is
 * process-global in bun test and leaks into other files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  getVapidConfig,
  isValidAuthSecret,
  isValidP256dh,
  isWebPushConfigured,
  sendWebPush,
} from '../../lib/web-push.js';

// A real, matching P-256 pair — a mismatched one imports and then signs
// something the push service rejects, so the test double must be genuine.
const VAPID = {
  publicKey:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  subject: 'mailto:ops@example.com',
};
const SUB = {
  endpoint: 'https://push.example.com/send/abc',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};
const MSG = { title: 't', body: 'b' };

let originalFetch: typeof fetch;
let seen: { url: string; init?: RequestInit } | null;

function stubFetch(status: number): void {
  seen = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init };
    return {
      status,
      ok: status < 400,
      headers: new Headers(),
      text: async () => '',
    } as Response;
  }) as unknown as typeof fetch;
}

describe('sendWebPush', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends aes128gcm with a VAPID Authorization header', async () => {
    stubFetch(201);
    expect(await sendWebPush(SUB, MSG, {}, VAPID)).toBe('sent');

    const headers = seen?.init?.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers.TTL).toBe('86400');
    expect(headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(headers.Authorization).toContain(`k=${VAPID.publicKey}`);
    // The body is the encrypted record, not the plaintext.
    const body = seen?.init?.body as Uint8Array;
    expect(body.byteLength).toBeGreaterThan(86); // header (86) + ciphertext + tag
    expect(new TextDecoder().decode(body)).not.toContain('"title"');
  });

  it('scopes the JWT audience to the endpoint ORIGIN', async () => {
    stubFetch(201);
    await sendWebPush(SUB, MSG, {}, VAPID);
    const headers = seen?.init?.headers as Record<string, string> | undefined;
    const auth = headers?.Authorization ?? '';
    const claims = JSON.parse(
      atob(auth.split('t=')[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
    ) as { aud: string; sub: string; exp: number };
    expect(claims.aud).toBe('https://push.example.com'); // not the full URL
    expect(claims.sub).toBe(VAPID.subject);
    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it('refuses an endpoint pointing into private space, without fetching', async () => {
    stubFetch(201);
    const verdict = await sendWebPush(
      { ...SUB, endpoint: 'http://169.254.169.254/latest/meta-data/' },
      MSG,
      {},
      VAPID,
    );
    expect(verdict).toBe('failed');
    expect(seen).toBeNull(); // never left the process
  });

  it('calls a subscription expired ONLY when the service says it is gone', async () => {
    for (const status of [404, 410]) {
      stubFetch(status);
      expect(await sendWebPush(SUB, MSG, {}, VAPID)).toBe('expired');
    }
    // Everything else is about us or the service — it must not unsubscribe.
    for (const status of [400, 429, 500, 503]) {
      stubFetch(status);
      expect(await sendWebPush(SUB, MSG, {}, VAPID)).toBe('failed');
    }
  });

  it('stays off, and says so, when the keys are absent', async () => {
    stubFetch(201);
    expect(await sendWebPush(SUB, MSG, {}, null)).toBe('not-configured');
    expect(seen).toBeNull();
    expect(getVapidConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(isWebPushConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isWebPushConfigured({
        VAPID_PUBLIC_KEY: 'a',
        VAPID_PRIVATE_KEY: 'b',
        VAPID_SUBJECT: 'mailto:x@y.z',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    // Two of three is not configured — a half-set key pair must not half-send.
    expect(
      isWebPushConfigured({
        VAPID_PUBLIC_KEY: 'a',
        VAPID_PRIVATE_KEY: 'b',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('checks the subscription key shapes', () => {
    expect(isValidP256dh(SUB.p256dh)).toBe(true);
    expect(isValidP256dh('AAAA')).toBe(false);
    expect(isValidAuthSecret(SUB.auth)).toBe(true);
    expect(isValidAuthSecret('AAAA')).toBe(false);
  });
});
