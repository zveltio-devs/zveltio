/**
 * `zvd_webhooks` and `zvd_webhook_deliveries` are isolated by Postgres, not only
 * by `/api/webhooks`.
 *
 * Both carry `tenant_id` (016) and had no policy, so a reader that does not
 * filter by it — a whitelisted RPC function — saw every firm's webhooks, their
 * URLs and headers included. Migration 028 puts both under the tenant policy.
 *
 * A policy alone would have broken every reader that runs outside a tenant
 * transaction, and on a non-superuser database those answer for the default
 * firm only: the dispatcher's lookup of the writing firm's webhooks, the
 * delivery row it inserts, the delivery outcome and retry count written after
 * each attempt, and the boot repair of unsigned webhooks. The harness pool is a
 * superuser, where no policy binds, so those paths are driven here through a
 * pool whose every connection is `zveltio_rls` — what a correctly provisioned
 * install connects as.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { Kysely, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { BunSqlDialect } from '../../db/bun-sql-dialect.js';
import type { DbSchema } from '../../db/schema.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  WebhookManager,
  _settleWebhookDeliveries,
  repairUnsignedWebhooksAtBoot,
} from '../../lib/webhooks.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SLUG = `whrls-${OTHER.slice(0, 8)}`;
const STAMP = `whrls_${Date.now()}`;
const COLLECTION = `${STAMP}_c`;
const FN = 'harness_webhooks_rls_rows';

/** The harness URL, every connection opened as the plain role. */
function plainRoleUrl(): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', '-c role=zveltio_rls');
  return url.toString();
}

d('zvd_webhooks under tenant RLS', () => {
  let app: Hono;
  let db: Database;
  let plain: Database;
  let god = '';
  let originalFetch: typeof fetch;
  let hits = 0;
  const raw: Record<string, string> = {};

  const headers = (tenant: string, extra: Record<string, string>) => ({
    'Content-Type': 'application/json',
    ...extra,
    ...(tenant === OTHER ? { 'X-Tenant-Slug': SLUG } : {}),
  });

  async function seedWebhook(tenant: string, tag: string, secret: string | null): Promise<string> {
    const row = await sql<{ id: string }>`
      INSERT INTO zvd_webhooks (tenant_id, name, url, events, collections, secret, retry_attempts)
      VALUES (${tenant}::uuid, ${`${STAMP}-${tag}`}, 'https://example.com/whrls',
              ARRAY['*']::text[], ARRAY[${COLLECTION}]::text[], ${secret}, 1)
      RETURNING id::text AS id`.execute(db);
    return row.rows[0]!.id;
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    plain = new Kysely<DbSchema>({
      dialect: new BunSqlDialect({ connectionString: plainRoleUrl(), max: 4 }),
    }) as unknown as Database;
    const { userId } = await createMemberSession(app, db);
    god = await createGodSession(app, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    // A tenant key acts on its issuer's membership there.
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${OTHER}::uuid, ${userId}, 'member')`.execute(db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    for (const tenant of [ROOT, OTHER]) {
      await sql`INSERT INTO zvd_webhooks (name, tenant_id, url, events, active, secret)
                VALUES (${`${STAMP}-seed`}, ${tenant}::uuid, 'https://example.com/seed',
                        ARRAY['none']::text[], false, 'x')`.execute(db);
      raw[tenant] = generateApiKey();
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
        VALUES (${`${STAMP}-${tenant}`}, ${await hashApiKey(raw[tenant]!)}, ${raw[tenant]!.slice(0, 12)},
                ${JSON.stringify([{ collection: '$rpc', actions: ['execute'] }])}::jsonb, true,
                ${tenant}::uuid, ${userId})`.execute(db);
    }
    // No tenant predicate anywhere in it: whatever it returns, the policy chose.
    await sql
      .raw(`CREATE OR REPLACE FUNCTION "${FN}"() RETURNS TABLE(tenant_id uuid)
            LANGUAGE sql STABLE AS $$
              SELECT tenant_id FROM zvd_webhooks WHERE name = '${STAMP}-seed'
              UNION ALL
              SELECT d.tenant_id FROM zvd_webhook_deliveries d
                JOIN zvd_webhooks w ON w.id = d.webhook_id AND w.name = '${STAMP}-seed'
            $$`)
      .execute(db);
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${FN}`.execute(db);
    await sql`INSERT INTO zvd_rpc_functions (function_name, required_role, is_enabled)
              VALUES (${FN}, 'member', true)`.execute(db);
    await sql`INSERT INTO zvd_webhook_deliveries (webhook_id, tenant_id, payload, url, method)
              SELECT id, tenant_id, '{}'::jsonb, url, 'POST' FROM zvd_webhooks
               WHERE name = ${`${STAMP}-seed`}`.execute(db);

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      hits++;
      return { status: 500, ok: false, text: async () => 'down' } as Response;
    }) as unknown as typeof fetch;
    WebhookManager.init(plain);
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    WebhookManager.init(db);
    await plain?.destroy().catch(() => undefined);
    if (!db) return;
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${FN}`.execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS "${FN}"()`).execute(db);
    await sql`DELETE FROM zvd_webhooks WHERE name LIKE ${`${STAMP}%`}`.execute(db);
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${STAMP}-%`}`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`).execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${COLLECTION}`.execute(db);
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${OTHER}::uuid`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('a reader with no tenant filter sees only its own firm’s webhooks and deliveries', async () => {
    for (const tenant of [OTHER, ROOT]) {
      const res = await app.request(`/api/rpc/${FN}`, {
        method: 'POST',
        headers: headers(tenant, { 'X-API-Key': raw[tenant]! }),
        body: '{}',
      });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { tenant_id: string }[] };
      expect(data.map((r) => r.tenant_id)).toEqual([tenant, tenant]);
    }
  });

  it('a write in a non-default firm fires its webhook, recorded and retried as that firm', async () => {
    const hook = await seedWebhook(OTHER, 'hook', null);
    await _settleWebhookDeliveries();
    hits = 0;

    // The real caller: the data route's afterWrite, inside the request transaction.
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: headers(OTHER, { cookie: god }),
      body: JSON.stringify({ title: 'probe' }),
    });
    expect([200, 201]).toContain(res.status);
    await _settleWebhookDeliveries();
    expect(hits).toBe(2); // the first try plus the one retry

    // The outcome is written after the attempt, not awaited by it.
    let row: { tenant_id: string; status: number | null; attempt: number } | undefined;
    for (let i = 0; i < 50; i++) {
      row = (
        await sql<{ tenant_id: string; status: number | null; attempt: number }>`
          SELECT tenant_id::text AS tenant_id, status, attempt FROM zvd_webhook_deliveries
           WHERE webhook_id = ${hook}::uuid`.execute(db)
      ).rows[0];
      if (row?.status != null && row.attempt === 2) break;
      await Bun.sleep(100);
    }
    expect(row).toEqual({ tenant_id: OTHER, status: 500, attempt: 2 });
  }, 60_000);

  it('the boot repair signs every firm’s unsigned webhook', async () => {
    const hook = await seedWebhook(OTHER, 'unsigned', null);
    await sql`UPDATE zvd_webhooks SET active = false WHERE id = ${hook}::uuid`.execute(db);
    await repairUnsignedWebhooksAtBoot(plain);
    const r = await sql<{ secret: string | null }>`
      SELECT secret FROM zvd_webhooks WHERE id = ${hook}::uuid`.execute(db);
    expect(r.rows[0]?.secret).toBeTruthy();
  });

  it('the webhook routes create, list, edit and delete in a non-default firm', async () => {
    const create = await app.request('/api/webhooks', {
      method: 'POST',
      headers: headers(OTHER, { cookie: god }),
      body: JSON.stringify({
        name: `${STAMP}-route`,
        url: 'https://example.com/route',
        events: ['insert'],
        active: false,
      }),
    });
    expect(create.status).toBe(201);
    const { webhook } = (await create.json()) as { webhook: { id: string; tenant_id: string } };
    expect(webhook.tenant_id).toBe(OTHER);

    const listed = async (tenant: string) => {
      const res = await app.request('/api/webhooks', { headers: headers(tenant, { cookie: god }) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { webhooks: { name: string }[] };
      return body.webhooks.map((w) => w.name).filter((n) => n.startsWith(`${STAMP}-route`));
    };
    expect(await listed(OTHER)).toEqual([`${STAMP}-route`]);
    expect(await listed(ROOT)).toEqual([]);

    const patch = await app.request(`/api/webhooks/${webhook.id}`, {
      method: 'PATCH',
      headers: headers(OTHER, { cookie: god }),
      body: JSON.stringify({ name: `${STAMP}-route2` }),
    });
    expect(patch.status).toBe(200);
    const rotate = await app.request(`/api/webhooks/${webhook.id}/rotate-secret`, {
      method: 'POST',
      headers: headers(OTHER, { cookie: god }),
    });
    expect(rotate.status).toBe(200);
    const deliveries = await app.request(`/api/webhooks/${webhook.id}/deliveries`, {
      headers: headers(OTHER, { cookie: god }),
    });
    expect(deliveries.status).toBe(200);

    const elsewhere = await app.request(`/api/webhooks/${webhook.id}`, {
      headers: headers(ROOT, { cookie: god }),
    });
    expect(elsewhere.status).toBe(404);

    const del = await app.request(`/api/webhooks/${webhook.id}`, {
      method: 'DELETE',
      headers: headers(OTHER, { cookie: god }),
    });
    expect(del.status).toBe(200);
  }, 30_000);

  it('a firm cannot write a webhook into another firm', async () => {
    const write = withTenantIsolation(OTHER, (trx) =>
      sql`INSERT INTO zvd_webhooks (name, tenant_id, url, events)
          VALUES (${`${STAMP}-x`}, ${ROOT}::uuid, 'https://example.com/x', ARRAY['*']::text[])`.execute(
        trx,
      ),
    );
    await expect(write).rejects.toThrow(/row-level security/);
  });
});
