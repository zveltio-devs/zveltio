/**
 * Phase C — webhooks tenant isolation. Two regressions:
 *  1. routes/webhooks.ts ran on the raw pool with no tenant scope, so the
 *     admin of tenant A could list/read/patch/delete/test/rotate-secret tenant
 *     B's webhooks by id (cross-tenant IDOR; rotate-secret returns plaintext).
 *  2. lib/webhooks.ts WebhookManager.trigger() matched webhooks across ALL
 *     tenants, so a write in tenant A fired tenant B's webhook and POSTed A's
 *     record data to B's endpoint (cross-tenant data exfiltration).
 *
 * Plus the doors of tenant-isolation-doors.test.ts: delivery logs, the test
 * send, and the dead-letter list and replay.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { WebhookManager } from '../../lib/webhooks.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { FakeRedis } from '../../testing/fake-redis.js';
import { WEBHOOK_DLQ_KEY } from '../../lib/webhook-worker.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const FOREIGN_ID = '00000000-0000-4000-8000-0000000000e1';
const FOREIGN_DISPATCH_ID = '00000000-0000-4000-8000-0000000000e2';
const MINE_DISPATCH_ID = '00000000-0000-4000-8000-0000000000e3';
const STAMP = Date.now();

d('webhooks tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let myId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    WebhookManager.init(db);

    // A webhook belonging to ANOTHER tenant, inserted directly (route IDOR target).
    await db
      .insertInto('zvd_webhooks')
      .values({
        id: FOREIGN_ID,
        name: `foreign-${STAMP}`,
        url: 'https://example.com/foreign',
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
    if (!db) return;
    for (const id of [FOREIGN_ID, FOREIGN_DISPATCH_ID, MINE_DISPATCH_ID, myId].filter(Boolean)) {
      await db
        .deleteFrom('zvd_webhook_deliveries')
        .where('webhook_id', '=', id)
        .execute()
        .catch(() => {});
      await db
        .deleteFrom('zvd_webhooks')
        .where('id', '=', id)
        .execute()
        .catch(() => {});
    }
  });

  it('single-tenant: create + list works and hides the other tenant’s webhook', async () => {
    const create = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `mine-${STAMP}`,
        url: 'https://example.com/mine',
        events: ['insert'],
      }),
    });
    expect(create.status).toBe(201);
    myId = ((await create.json()) as { webhook: { id: string } }).webhook.id;

    const list = await app.request('/api/webhooks', { headers: { cookie } });
    expect(list.status).toBe(200);
    const ids = ((await list.json()) as { webhooks: { id: string }[] }).webhooks.map((w) => w.id);
    expect(ids).toContain(myId);
    expect(ids).not.toContain(FOREIGN_ID);
  });

  it('cross-tenant: GET /webhooks/:id of another tenant → 404', async () => {
    const res = await app.request(`/api/webhooks/${FOREIGN_ID}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('cross-tenant: PATCH does not modify another tenant’s webhook', async () => {
    const res = await app.request(`/api/webhooks/${FOREIGN_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(res.status).toBe(404);
    const still = await db
      .selectFrom('zvd_webhooks')
      .select('name')
      .where('id', '=', FOREIGN_ID)
      .executeTakeFirst();
    expect(still?.name).toBe(`foreign-${STAMP}`); // untouched
  });

  it('cross-tenant: DELETE does not remove another tenant’s webhook', async () => {
    const res = await app.request(`/api/webhooks/${FOREIGN_ID}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    const still = await db
      .selectFrom('zvd_webhooks')
      .select('id')
      .where('id', '=', FOREIGN_ID)
      .executeTakeFirst();
    expect(still?.id).toBe(FOREIGN_ID);
  });

  it('cross-tenant: rotate-secret on another tenant’s webhook → 404', async () => {
    const res = await app.request(`/api/webhooks/${FOREIGN_ID}/rotate-secret`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('dispatcher: a write in one tenant only fires THAT tenant’s webhooks', async () => {
    // Two webhooks matching the same event/collection, different tenants.
    await db
      .insertInto('zvd_webhooks')
      .values({
        id: MINE_DISPATCH_ID,
        name: `disp-mine-${STAMP}`,
        url: 'https://example.com/mine-disp',
        method: 'POST',
        events: ['*'] as unknown as string[],
        collections: [] as unknown as string[],
        active: true,
        secret: null,
        retry_attempts: 3,
        timeout: 5000,
        tenant_id: DEFAULT_TENANT_ID,
      } as never)
      .execute();
    await db
      .insertInto('zvd_webhooks')
      .values({
        id: FOREIGN_DISPATCH_ID,
        name: `disp-foreign-${STAMP}`,
        url: 'https://example.com/foreign-disp',
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

    // Fire an event as the DEFAULT tenant.
    await WebhookManager.trigger(
      'insert',
      'things',
      { id: '00000000-0000-4000-8000-0000000000ab' },
      DEFAULT_TENANT_ID,
    );

    const mineDeliveries = await db
      .selectFrom('zvd_webhook_deliveries')
      .select('id')
      .where('webhook_id', '=', MINE_DISPATCH_ID)
      .execute();
    const foreignDeliveries = await db
      .selectFrom('zvd_webhook_deliveries')
      .select('id')
      .where('webhook_id', '=', FOREIGN_DISPATCH_ID)
      .execute();

    expect(mineDeliveries.length).toBeGreaterThan(0); // fired for the writing tenant
    expect(foreignDeliveries.length).toBe(0); // NOT for the other tenant
  });

  it("cross-tenant: another tenant's delivery log is not listed; mine is", async () => {
    const delivery = (webhook_id: string, tenant_id: string) => ({
      webhook_id,
      tenant_id,
      payload: JSON.stringify({ probe: STAMP }),
      url: 'https://example.com/x',
      method: 'POST',
    });
    await db
      .insertInto('zvd_webhook_deliveries')
      .values([delivery(FOREIGN_ID, OTHER_TENANT), delivery(myId, DEFAULT_TENANT_ID)] as never)
      .execute();
    const list = async (id: string) => {
      const res = await app.request(`/api/webhooks/${id}/deliveries`, { headers: { cookie } });
      expect(res.status).toBe(200);
      return ((await res.json()) as { deliveries: unknown[] }).deliveries;
    };
    expect(await list(FOREIGN_ID)).toEqual([]);
    expect((await list(myId)).length).toBeGreaterThan(0);
  });

  it("cross-tenant: a test send of another tenant's webhook → 404", async () => {
    const res = await app.request(`/api/webhooks/${FOREIGN_ID}/test`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it("cross-tenant: another tenant's dead letters are neither listed nor replayed", async () => {
    // The harness has no Valkey. FakeRedis has no lists, which these two
    // routes use; the tenant middleware uses the rest.
    const lists = new Map<string, string[]>();
    const list = (k: string) => lists.get(k) ?? lists.set(k, []).get(k)!;
    _setCacheForTests(
      Object.assign(new FakeRedis(), {
        lrange: async (k: string, from: number, to: number) =>
          list(k).slice(from, to === -1 ? undefined : to + 1),
        rpush: async (k: string, v: string) => list(k).push(v),
        lrem: async (k: string, _n: number, v: string) => {
          const i = list(k).indexOf(v);
          if (i !== -1) list(k).splice(i, 1);
          return i === -1 ? 0 : 1;
        },
      }) as never,
    );
    try {
      const foreign = JSON.stringify({ webhookId: FOREIGN_ID, failedAt: 1 });
      const mine = JSON.stringify({ webhookId: myId, failedAt: 2 });
      list(WEBHOOK_DLQ_KEY).push(foreign, mine);

      const res = await app.request('/api/webhooks/dlq', { headers: { cookie } });
      expect(res.status).toBe(200);
      const { entries } = (await res.json()) as { entries: { webhookId: string }[] };
      expect(entries.map((e) => e.webhookId)).toEqual([myId]);

      const replay = await app.request('/api/webhooks/dlq/replay', {
        method: 'POST',
        headers: { cookie },
      });
      expect(((await replay.json()) as { replayed: number }).replayed).toBe(1);
      expect(list(WEBHOOK_DLQ_KEY)).toEqual([foreign]);
      expect(list('webhook:queue').map((e) => JSON.parse(e).webhookId)).toEqual([myId]);
    } finally {
      _setCacheForTests(null);
    }
  });
});
