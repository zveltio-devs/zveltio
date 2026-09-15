/**
 * The webhook dead-letter queue, exercised through its routes.
 *
 * The DLQ is a flat Redis list shared by every tenant, so `GET /dlq` and
 * `POST /dlq/replay` have to decide which entries belong to the caller. They
 * decided it by URL: the set of URLs this tenant's webhooks point at. A URL is
 * not an ownership claim — it is a value any tenant can type into its own
 * webhook — so registering a webhook at the URL another tenant already uses
 * hands over that tenant's abandoned payloads, which carry the record data of
 * the write that fired them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type Redis from 'ioredis';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { WEBHOOK_DLQ_KEY } from '../../lib/webhook-worker.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000fe';
const FOREIGN_ID = '00000000-0000-4000-8000-0000000000d1';
const STAMP = Date.now();
const SHARED_URL = `https://example.com/shared-${STAMP}`;

/** Just enough of the cache surface for the two DLQ handlers. */
class FakeCache {
  lists = new Map<string, string[]>();
  kv = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.kv.set(key, value);
    return 'OK';
  }
  async setex(key: string, _ttl: number, value: string): Promise<'OK'> {
    this.kv.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<number> {
    return this.kv.delete(key) ? 1 : 0;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key) ?? [];
    return stop === -1 ? l.slice(start) : l.slice(start, stop + 1);
  }
  async rpush(key: string, value: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.push(value);
    this.lists.set(key, l);
    return l.length;
  }
  async lrem(key: string, _count: number, value: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    const i = l.indexOf(value);
    if (i >= 0) l.splice(i, 1);
    this.lists.set(key, l);
    return i >= 0 ? 1 : 0;
  }
}

d('webhook dead-letter queue routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let cache: FakeCache;
  let mineId = '';

  const foreignEntry = JSON.stringify({
    webhookId: FOREIGN_ID,
    url: SHARED_URL,
    event: 'insert',
    collection: 'salaries',
    data: { id: 'x', amount: 'the other tenant’s record' },
    attempt: 3,
    failedAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    cache = new FakeCache();
    _setCacheForTests(cache as unknown as Redis);

    await db
      .insertInto('zvd_webhooks')
      .values({
        id: FOREIGN_ID,
        name: `foreign-dlq-${STAMP}`,
        url: SHARED_URL,
        method: 'POST',
        events: ['*'] as unknown as string[],
        collections: [] as unknown as string[],
        active: true,
        secret: null,
        retry_attempts: 3,
        timeout: 5000,
        tenant_id: OTHER_TENANT,
      } as never)
      .execute();
  });

  afterAll(async () => {
    _setCacheForTests(null);
    if (!db) return;
    for (const id of [FOREIGN_ID, mineId].filter(Boolean)) {
      await db
        .deleteFrom('zvd_webhooks')
        .where('id', '=', id)
        .execute()
        .catch(() => {});
    }
  });

  it('lists this tenant’s own abandoned deliveries', async () => {
    const create = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `mine-dlq-${STAMP}`,
        url: `https://example.com/mine-${STAMP}`,
        events: ['insert'],
      }),
    });
    expect(create.status).toBe(201);
    mineId = ((await create.json()) as { webhook: { id: string } }).webhook.id;

    cache.lists.set(WEBHOOK_DLQ_KEY, [
      JSON.stringify({
        webhookId: mineId,
        url: `https://example.com/mine-${STAMP}`,
        event: 'insert',
        collection: 'things',
        data: { id: 'mine' },
        attempt: 3,
        // What the worker actually abandons: `trigger` puts the DECRYPTED
        // signing secret on the queue payload, and `pushToDeadLetter` spreads
        // that payload into the DLQ entry unchanged.
        secret: 'plaintext-signing-secret',
      }),
    ]);

    const res = await app.request('/api/webhooks/dlq', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { webhookId?: string; secret?: unknown }[];
      available: boolean;
    };
    expect(body.available).toBe(true);
    expect(body.entries.map((e) => e.webhookId)).toEqual([mineId]);
    // Every other handler masks it; this one must not be the exception.
    expect(body.entries[0]?.secret).toBeUndefined();
  });

  it('does not list another tenant’s entry that happens to share a URL', async () => {
    // This tenant registers a webhook at the URL the other tenant already uses.
    const create = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `copycat-${STAMP}`, url: SHARED_URL, events: ['insert'] }),
    });
    expect(create.status).toBe(201);
    const copycatId = ((await create.json()) as { webhook: { id: string } }).webhook.id;

    cache.lists.set(WEBHOOK_DLQ_KEY, [foreignEntry]);

    const res = await app.request('/api/webhooks/dlq', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { webhookId?: string }[] };
    expect(body.entries.map((e) => e.webhookId)).not.toContain(FOREIGN_ID);

    await db
      .deleteFrom('zvd_webhooks')
      .where('id', '=', copycatId)
      .execute()
      .catch(() => {});
  });

  it('does not replay another tenant’s entry that happens to share a URL', async () => {
    const create = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `copycat2-${STAMP}`, url: SHARED_URL, events: ['insert'] }),
    });
    expect(create.status).toBe(201);
    const copycatId = ((await create.json()) as { webhook: { id: string } }).webhook.id;

    cache.lists.set(WEBHOOK_DLQ_KEY, [foreignEntry]);
    cache.lists.set('webhook:queue', []);

    const res = await app.request('/api/webhooks/dlq/replay', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { replayed: number }).toEqual({ replayed: 0 });
    // The other tenant's entry is still in the DLQ, and nothing was queued.
    expect(cache.lists.get('webhook:queue')).toEqual([]);
    expect(cache.lists.get(WEBHOOK_DLQ_KEY)).toEqual([foreignEntry]);

    await db
      .deleteFrom('zvd_webhooks')
      .where('id', '=', copycatId)
      .execute()
      .catch(() => {});
  });

  it('replays its own entry with the signing secret re-read from the webhook row', async () => {
    const created = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `replay-${STAMP}`,
        url: `https://example.com/replay-${STAMP}`,
        events: ['insert'],
      }),
    });
    expect(created.status).toBe(201);
    const { webhook, secret: plaintext } = (await created.json()) as {
      webhook: { id: string };
      secret: string;
    };

    // What the worker leaves behind: no `secret` field at all.
    const entry = JSON.stringify({
      webhookId: webhook.id,
      url: `https://example.com/replay-${STAMP}`,
      event: 'insert',
      collection: 'things',
      data: { id: 'mine' },
      attempt: 3,
      failedAt: new Date().toISOString(),
    });
    cache.lists.set(WEBHOOK_DLQ_KEY, [entry]);
    cache.lists.set('webhook:queue', []);

    const res = await app.request('/api/webhooks/dlq/replay', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ replayed: 1 });

    const queued = (cache.lists.get('webhook:queue') ?? []).map(
      (s) => JSON.parse(s) as { secret?: string | null; attempt: number },
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.attempt).toBe(0);
    expect(queued[0]?.secret).toBe(plaintext);
    expect(cache.lists.get(WEBHOOK_DLQ_KEY)).toEqual([]);

    await db
      .deleteFrom('zvd_webhooks')
      .where('id', '=', webhook.id)
      .execute()
      .catch(() => {});
  });

  it('DEFAULT_TENANT_ID is the acting tenant here', () => {
    expect(DEFAULT_TENANT_ID).toBeTruthy();
  });
});
