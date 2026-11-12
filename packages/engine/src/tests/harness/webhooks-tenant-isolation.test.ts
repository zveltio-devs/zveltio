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
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  asEveryTenant,
  asTenant,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { DDLManager } from '../../lib/data/index.js';

const THINGS = `things_${Date.now()}`;
import { enqueueChangeEvent, WEBHOOK_QUEUE, WebhookManager } from '../../lib/webhooks.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { toJsonb } from '../../lib/jsonb.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';

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
    // A real collection: a webhook or a data trigger reads its record as its
    // role (ADR 0004), and a role reads collections only.
    await DDLManager.createCollection(db, {
      name: THINGS,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    cookie = await createGodSession(app, db);
    WebhookManager.init(db);

    // A webhook belonging to ANOTHER tenant, inserted directly (route IDOR target)
    // — a firm that exists, so the test's own every-firm reads reach it.
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER_TENANT}::uuid, ${`wh-iso-${STAMP}`}, 'wh-iso', 'active')
              ON CONFLICT (id) DO NOTHING`.execute(db);
    await asTenant(db, OTHER_TENANT, (trx) =>
      trx
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
        .execute(),
    );
  });

  afterAll(async () => {
    if (!db) return;
    await dropTestCollection(db, THINGS).catch(() => {});
    await sql`DELETE FROM pgboss.job WHERE name = ${WEBHOOK_QUEUE} AND data->>'webhookId' = ANY(${[
      FOREIGN_ID,
      FOREIGN_DISPATCH_ID,
      MINE_DISPATCH_ID,
      myId,
    ]})`
      .execute(db)
      .catch(() => {});
    for (const id of [FOREIGN_ID, FOREIGN_DISPATCH_ID, MINE_DISPATCH_ID, myId].filter(Boolean)) {
      await asEveryTenant(db, (trx) =>
        trx.deleteFrom('zvd_webhook_deliveries').where('webhook_id', '=', id).execute(),
      ).catch(() => {});
      await asEveryTenant(db, (trx) =>
        trx.deleteFrom('zvd_webhooks').where('id', '=', id).execute(),
      ).catch(() => {});
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER_TENANT}::uuid`.execute(db).catch(() => {});
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
    const still = await asEveryTenant(db, (trx) =>
      trx.selectFrom('zvd_webhooks').select('name').where('id', '=', FOREIGN_ID).executeTakeFirst(),
    );
    expect(still?.name).toBe(`foreign-${STAMP}`); // untouched
  });

  it('cross-tenant: DELETE does not remove another tenant’s webhook', async () => {
    const res = await app.request(`/api/webhooks/${FOREIGN_ID}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    const still = await asEveryTenant(db, (trx) =>
      trx.selectFrom('zvd_webhooks').select('id').where('id', '=', FOREIGN_ID).executeTakeFirst(),
    );
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
    await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      trx
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
        .execute(),
    );
    await asTenant(db, OTHER_TENANT, (trx) =>
      trx
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
        .execute(),
    );

    // An event of the DEFAULT tenant, queued as its write's transaction queues it.
    await withTenantIsolation(DEFAULT_TENANT_ID, (trx) =>
      enqueueChangeEvent(trx, DEFAULT_TENANT_ID, {
        id: crypto.randomUUID(),
        event: 'insert',
        collection: THINGS,
        data: { id: '00000000-0000-4000-8000-0000000000ab' },
        timestamp: new Date().toISOString(),
      }),
    );
    const queuedFor = async (id: string) =>
      (
        await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pgboss.job
           WHERE name = ${WEBHOOK_QUEUE} AND data->>'webhookId' = ${id}`.execute(db)
      ).rows[0]!.n;

    expect(await queuedFor(MINE_DISPATCH_ID)).toBe(1); // queued for the writing tenant
    expect(await queuedFor(FOREIGN_DISPATCH_ID)).toBe(0); // NOT for the other tenant
  });

  it("cross-tenant: another tenant's delivery log is not listed; mine is", async () => {
    const delivery = (webhook_id: string, tenant_id: string) => ({
      webhook_id,
      tenant_id,
      payload: JSON.stringify({ probe: STAMP }),
      url: 'https://example.com/x',
      method: 'POST',
    });
    for (const [id, tenant] of [
      [FOREIGN_ID, OTHER_TENANT],
      [myId, DEFAULT_TENANT_ID],
    ] as const) {
      await asTenant(db, tenant, (trx) =>
        trx
          .insertInto('zvd_webhook_deliveries')
          .values(delivery(id, tenant) as never)
          .execute(),
      );
    }
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
    // A delivery whose job used its last retry, in each firm (ADR 0035).
    const dead = async (webhookId: string, tenant: string) => {
      const eventId = crypto.randomUUID();
      await asTenant(db, tenant, (trx) =>
        trx
          .insertInto('zvd_webhook_deliveries')
          .values({
            webhook_id: webhookId,
            event_id: eventId,
            tenant_id: tenant,
            // An object, as the job stores it: a JSON string bound to jsonb is a string scalar.
            payload: toJsonb({ id: eventId, sequence: 1, event: 'insert', data: {} }),
            url: 'https://example.com/x',
            method: 'POST',
            attempt: 4,
            max_attempts: 3,
          } as never)
          .execute(),
      );
      return eventId;
    };
    const foreign = await dead(FOREIGN_ID, OTHER_TENANT);
    const mine = await dead(myId, DEFAULT_TENANT_ID);

    const res = await app.request('/api/webhooks/dlq?limit=500', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { eventId: string }[] };
    const ids = entries.map((e) => e.eventId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(foreign);

    const replay = await app.request('/api/webhooks/dlq/replay', {
      method: 'POST',
      headers: { cookie },
    });
    expect(replay.status).toBe(200);
    const queued = await sql<{ event: string }>`
      SELECT data->>'eventId' AS event FROM pgboss.job
       WHERE name = ${WEBHOOK_QUEUE} AND data->>'eventId' = ANY(${[foreign, mine]})`.execute(db);
    expect(queued.rows.map((r) => r.event)).toEqual([mine]);
    const left = await asTenant(db, OTHER_TENANT, (trx) =>
      sql<{ attempt: number }>`
        SELECT attempt FROM zvd_webhook_deliveries WHERE event_id = ${foreign}::uuid`.execute(trx),
    );
    expect(left.rows).toEqual([{ attempt: 4 }]); // still dead, still the other firm's
  });
});
