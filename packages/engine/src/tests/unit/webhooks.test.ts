/**
 * Unit coverage for webhooks.ts — WebhookManager delivery + trigger.
 *
 * deliver() signs the payload (HMAC-SHA256), strips exploitable headers, guards
 * the target URL (SSRF), POSTs via safeFetch, and records the outcome. trigger()
 * matches active webhooks in zvd_webhooks and (no Valkey in tests) delivers
 * directly.
 *
 * Driven with a stubbed globalThis.fetch (safeFetch wraps it) + CannedDb. No
 * network, no Postgres, no Valkey (getCache() returns null in the unit env).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { WebhookManager } from '../../lib/webhooks.js';
import { CannedDb } from './fixtures/canned-db.js';

let originalFetch: typeof fetch;
let lastReq: { url: string; init?: RequestInit } | null;

function stubFetch(status = 200, ok = status < 400): void {
  lastReq = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    lastReq = { url: String(input), init };
    return { status, ok, text: async () => 'ok-body' } as Response;
  }) as unknown as typeof fetch;
}

function headers(): Record<string, string> {
  return (lastReq?.init?.headers as Record<string, string>) ?? {};
}

const basePayload = {
  url: 'https://hooks.example.com/receive',
  event: 'record.created',
  collection: 'contacts',
  data: { id: 'r1', name: 'Ada' },
  timestamp: '2026-07-10T00:00:00.000Z',
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  WebhookManager.init(null as unknown as Database); // reset module _db
});

describe('WebhookManager.deliver', () => {
  it('POSTs the JSON payload and returns true on 2xx', async () => {
    const ok = await WebhookManager.deliver({ ...basePayload });
    expect(ok).toBe(true);
    expect(lastReq?.url).toBe(basePayload.url);
    expect(headers()['Content-Type']).toBe('application/json');
    expect(JSON.parse(lastReq?.init?.body as string)).toEqual({
      event: basePayload.event,
      collection: basePayload.collection,
      data: basePayload.data,
      timestamp: basePayload.timestamp,
    });
  });

  it('signs the body with HMAC-SHA256 when a secret is present', async () => {
    await WebhookManager.deliver({ ...basePayload, secret: 'sh-secret' });
    const sig = headers()['X-Zveltio-Signature'];
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Recompute the expected signature independently and compare exactly.
    const enc = new TextEncoder();
    const body = JSON.stringify({
      event: basePayload.event,
      collection: basePayload.collection,
      data: basePayload.data,
      timestamp: basePayload.timestamp,
    });
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode('sh-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const expected = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    const expectedHex = `sha256=${Array.from(new Uint8Array(expected))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;
    expect(sig).toBe(expectedHex);
  });

  it('strips exploitable headers but forwards custom ones', async () => {
    await WebhookManager.deliver({
      ...basePayload,
      headers: { Authorization: 'Bearer leak', Cookie: 'sid=1', 'X-Custom': 'keep' },
    });
    const h = headers();
    expect(h['X-Custom']).toBe('keep');
    expect(h.Authorization).toBeUndefined();
    expect(h.Cookie).toBeUndefined();
  });

  it('blocks an internal target URL (SSRF) and never fetches', async () => {
    const ok = await WebhookManager.deliver({ ...basePayload, url: 'http://127.0.0.1/admin' });
    expect(ok).toBe(false);
    expect(lastReq).toBeNull();
  });

  it('returns false on a non-2xx response', async () => {
    stubFetch(500);
    const ok = await WebhookManager.deliver({ ...basePayload });
    expect(ok).toBe(false);
  });

  it('treats a non-Error throw as a failed delivery', async () => {
    globalThis.fetch = (async () => {
      throw 'network down';
    }) as unknown as typeof fetch;
    const ok = await WebhookManager.deliver({ ...basePayload });
    expect(ok).toBe(false);
    expect(lastReq).toBeNull();
  });

  it('still returns delivery outcome when reading the response body fails', async () => {
    globalThis.fetch = (async () =>
      ({
        status: 200,
        ok: true,
        text: async () => {
          throw new Error('body unreadable');
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const ok = await WebhookManager.deliver({ ...basePayload });
    expect(ok).toBe(true);
  });

  it('records the delivery outcome when a deliveryId + db are present', async () => {
    const db = new CannedDb();
    db.when(/update "zvd_webhook_deliveries"/i, []);
    WebhookManager.init(db.kysely as unknown as Database);

    await WebhookManager.deliver({ ...basePayload, deliveryId: 'del-1' });
    // The update is fire-and-forget (.catch) — let it flush.
    await new Promise((r) => setTimeout(r, 25));
    expect(db.executed(/update "zvd_webhook_deliveries"/i).length).toBe(1);
  });
});

describe('WebhookManager.trigger', () => {
  it('is a no-op when not initialized with a db', async () => {
    WebhookManager.init(null as unknown as Database);
    await expect(
      WebhookManager.trigger('record.created', 'c', { id: '1' }),
    ).resolves.toBeUndefined();
    expect(lastReq).toBeNull();
  });

  it('matches active webhooks and delivers directly when no cache is configured', async () => {
    const db = new CannedDb();
    db.when(/from zvd_webhooks/i, [
      {
        id: 'wh1',
        url: 'https://hooks.example.com/trigger',
        method: 'POST',
        events: ['*'],
        collections: null,
        retry_attempts: 3,
      },
    ]);
    db.when(/insert into "zvd_webhook_deliveries"/i, [{ id: 'del-9' }]);
    WebhookManager.init(db.kysely as unknown as Database);

    await WebhookManager.trigger('record.created', 'contacts', { id: 'r1' });
    // No Valkey → deliver() is fire-and-forget; let it flush.
    await new Promise((r) => setTimeout(r, 50));
    expect(lastReq?.url).toBe('https://hooks.example.com/trigger');
  });
});
