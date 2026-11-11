/**
 * Unit coverage for webhooks.ts — WebhookManager.deliver, one POST.
 *
 * deliver() signs the envelope (HMAC-SHA256), strips exploitable headers, guards
 * the target URL (SSRF), POSTs via safeFetch, and reports the outcome. The job
 * around it (lookup, delivery row, retries) is pg-boss's and is covered by the
 * harness (ADR 0035).
 *
 * Driven with a stubbed globalThis.fetch (safeFetch wraps it). No network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { _setBossForTests } from '../../lib/data/ddl-queue.js';
import { ProblemException } from '../../lib/problem.js';
import { enqueueWebhookEvent, WebhookManager } from '../../lib/webhooks.js';
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

/**
 * `safeFetch` pins a resolved hostname to its ADDRESS: it calls `fetch` with
 * `https://<ip>/…` and moves the name into a `Host` header, and it builds a
 * `Headers` object to do so — the plain record the caller passed is gone by
 * then.
 *
 * So whether these assertions hold was a property of the resolver, not of the
 * code: a name that does not resolve leaves the request untouched, one that
 * does resolve rewrites it. The tests passed on a developer machine and failed
 * on the CI runner, on branches that touched nothing near webhooks. Moving
 * them to a `.invalid` host did not help — that runner's resolver answers
 * every name, `hooks.invalid` included, with 93.184.216.34.
 *
 * These two helpers undo the pinning instead, which works under any resolver:
 * the `Host` header is exactly the authority that was replaced.
 *
 * Since #1541 a name that does not resolve is refused, not fetched, so a host
 * name made these tests depend on the resolver again. They use a public IP
 * literal: nothing is resolved and nothing is pinned.
 */
function headers(): Record<string, string> {
  const h = lastReq?.init?.headers;
  const entries =
    h instanceof Headers
      ? [...h.entries()]
      : Object.entries((h as Record<string, string> | undefined) ?? {});
  // `Headers` lower-cases its keys; callers below ask for `Content-Type`.
  return Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), v]));
}

/** The URL as the caller wrote it, with any address pinning reversed. */
function sentUrl(): string | undefined {
  if (!lastReq) return undefined;
  const host = headers().host;
  if (!host) return lastReq.url;
  const u = new URL(lastReq.url);
  u.host = host;
  return u.toString();
}

const basePayload = {
  id: '7d0f6c1e-0000-4000-8000-000000000001',
  sequence: 42,
  url: 'https://93.184.216.34/receive',
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
});

describe('WebhookManager.deliver', () => {
  it('POSTs the JSON payload and returns ok on 2xx', async () => {
    const { ok } = await WebhookManager.deliver({ ...basePayload });
    expect(ok).toBe(true);
    expect(sentUrl()).toBe(basePayload.url);
    expect(headers()['content-type']).toBe('application/json');
    expect(JSON.parse(lastReq?.init?.body as string)).toEqual({
      id: basePayload.id,
      sequence: basePayload.sequence,
      event: basePayload.event,
      collection: basePayload.collection,
      data: basePayload.data,
      timestamp: basePayload.timestamp,
    });
  });

  it('signs the body with HMAC-SHA256 when a secret is present', async () => {
    await WebhookManager.deliver({ ...basePayload, secret: 'sh-secret' });
    const sig = headers()['x-zveltio-signature'];
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Recompute the expected signature independently and compare exactly.
    const enc = new TextEncoder();
    const body = JSON.stringify({
      id: basePayload.id,
      sequence: basePayload.sequence,
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

  it('sends with the method the webhook is configured for', async () => {
    await WebhookManager.deliver({ ...basePayload, method: 'PUT' });
    expect(lastReq?.init?.method).toBe('PUT');
  });

  it('strips exploitable headers but forwards custom ones', async () => {
    await WebhookManager.deliver({
      ...basePayload,
      headers: { Authorization: 'Bearer leak', Cookie: 'sid=1', 'X-Custom': 'keep' },
    });
    const h = headers();
    expect(h['x-custom']).toBe('keep');
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBeUndefined();
  });

  it('blocks an internal target URL (SSRF) and never fetches', async () => {
    const { ok } = await WebhookManager.deliver({ ...basePayload, url: 'http://127.0.0.1/admin' });
    expect(ok).toBe(false);
    expect(lastReq).toBeNull();
  });

  it('is not ok on a non-2xx response', async () => {
    stubFetch(500);
    const { ok } = await WebhookManager.deliver({ ...basePayload });
    expect(ok).toBe(false);
  });

  it('treats a non-Error throw as a failed delivery', async () => {
    globalThis.fetch = (async () => {
      throw 'network down';
    }) as unknown as typeof fetch;
    const { ok } = await WebhookManager.deliver({ ...basePayload });
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
    const { ok } = await WebhookManager.deliver({ ...basePayload });
    expect(ok).toBe(true);
  });
});

describe('enqueueWebhookEvent', () => {
  const change = {
    id: '7d0f6c1e-0000-4000-8000-000000000002',
    event: 'insert',
    collection: 'contacts',
    data: { id: 'r1' },
    timestamp: '2026-07-10T00:00:00.000Z',
  };

  it('refuses the write as webhooks.enqueue_failed (503) when the subscriber lookup fails', async () => {
    const db = new CannedDb();
    db.fail(/from zvd_webhooks/i, new Error('connection reset'));
    const err = await db.kysely
      .transaction()
      .execute((trx) => enqueueWebhookEvent(trx as unknown as Database, 'tenant-a', change))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).code).toBe('webhooks.enqueue_failed');
    expect((err as ProblemException).status).toBe(503);
    expect((err as ProblemException).message).toContain('connection reset');
  });

  it("a bulk write's events take one subscriber lookup, one nextval statement and one batch insert", async () => {
    const db = new CannedDb();
    db.when(/from zvd_webhooks/i, [
      { id: 'h1', retry_attempts: 2 },
      { id: 'h2', retry_attempts: 1 },
    ]);
    db.when(/nextval/i, [{ n: '7' }, { n: '8' }, { n: '9' }]);
    const batches: Array<
      Array<{ data: { webhookId: string; eventId: string; sequence: number } }>
    > = [];
    const previous = _setBossForTests({
      createQueue: async () => undefined,
      insert: async (_name: string, jobs: (typeof batches)[number]) => {
        batches.push(jobs);
        return jobs.map((_, i) => `job-${i}`);
      },
    });
    try {
      const rows = ['r1', 'r2', 'r3'].map((id, i) => ({
        ...change,
        id: `7d0f6c1e-0000-4000-8000-00000000001${i}`,
        data: { id },
      }));
      await db.kysely
        .transaction()
        .execute((trx) => enqueueWebhookEvent(trx as unknown as Database, 'tenant-a', rows));
      expect(db.executed(/from zvd_webhooks/i)).toHaveLength(1);
      expect(db.executed(/nextval/i)).toHaveLength(1);
      expect(batches).toHaveLength(1);
      // Every row to every subscriber; one sequence value per row, shared by its subscribers.
      expect(batches[0]!.map((j) => [j.data.webhookId, j.data.sequence])).toEqual([
        ['h1', 7],
        ['h2', 7],
        ['h1', 8],
        ['h2', 8],
        ['h1', 9],
        ['h2', 9],
      ]);
    } finally {
      _setBossForTests(previous);
    }
  });

  it("refuses a database that is not the write's transaction: the event would not commit with it", async () => {
    const db = new CannedDb();
    await expect(
      enqueueWebhookEvent(db.kysely as unknown as Database, 'tenant-a', change),
    ).rejects.toThrow('transaction');
    expect(db.executed(/zvd_webhooks/i)).toHaveLength(0);
  });
});
