/**
 * Webhooks — Integration Tests
 *
 * Tests webhook creation, triggering on insert, and delivery tracking.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/webhooks.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

const COLLECTION = `test_webhooks_${Date.now()}`;
let db: Database;
let godCookie: string;
let webhookId: string;
let inactiveWebhookId: string;

async function signUp(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Webhook God' }),
  });
  const body = await res.json();
  return body.user?.id ?? body.id;
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

/** Waits up to maxMs for at least one delivery to appear for a webhook. */
async function waitForDelivery(whId: string, maxMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const rows = await sql<{ id: string }>`
      SELECT id FROM zvd_webhook_deliveries WHERE webhook_id = ${whId} LIMIT 1
    `.execute(db);
    if (rows.rows.length > 0) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

beforeAll(async () => {
  if (skipAll) return;

  process.env.DATABASE_URL = TEST_DB_URL!;
  const { initDatabase } = await import('../../db/index.js');
  db = await initDatabase();

  const ts = Date.now();
  const email = `webhook-god-${ts}@test.local`;
  const pass = 'TestPass123!';

  const userId = await signUp(email, pass);
  await sql`UPDATE "user" SET role = 'god' WHERE id = ${userId}`.execute(db);
  godCookie = await signIn(email, pass);

  // Create test collection
  await fetch(`${BASE_URL}/api/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: godCookie },
    body: JSON.stringify({
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text' }],
    }),
  });

  // Create active webhook (points to a test endpoint — delivery will fail but entry is created)
  const whRes = await fetch(`${BASE_URL}/api/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: godCookie },
    body: JSON.stringify({
      name: `Test Webhook ${ts}`,
      url: 'https://httpbin.org/post',
      events: ['insert'],
      collections: [COLLECTION],
      active: true,
    }),
  });
  expect(whRes.status).toBe(201);
  const whBody = await whRes.json() as any;
  webhookId = whBody.webhook?.id ?? whBody.id;

  // Create inactive webhook
  const inactiveRes = await fetch(`${BASE_URL}/api/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: godCookie },
    body: JSON.stringify({
      name: `Inactive Webhook ${ts}`,
      url: 'https://httpbin.org/post',
      events: ['insert'],
      collections: [COLLECTION],
      active: false,
    }),
  });
  const inactiveBody = await inactiveRes.json() as any;
  inactiveWebhookId = inactiveBody.webhook?.id ?? inactiveBody.id;
}, 30_000);

afterAll(async () => {
  if (skipAll || !db) return;

  for (const id of [webhookId, inactiveWebhookId].filter(Boolean)) {
    await fetch(`${BASE_URL}/api/webhooks/${id}`, {
      method: 'DELETE',
      headers: { Cookie: godCookie },
    }).catch(() => {});
  }

  await fetch(`${BASE_URL}/api/collections/${COLLECTION}`, {
    method: 'DELETE',
    headers: { Cookie: godCookie },
  }).catch(() => {});

  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('Webhooks — Integration', () => {
  it('insert into collection creates a webhook delivery entry', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: godCookie },
      body: JSON.stringify({ title: 'Webhook trigger test' }),
    });
    expect(res.status).toBe(200);

    const delivered = await waitForDelivery(webhookId, 5000);
    expect(delivered).toBe(true);
  }, 15_000);

  it('webhook delivery record is persisted in zvd_webhook_deliveries', async () => {
    const rows = await sql<{ id: string; status: string }>`
      SELECT id, status FROM zvd_webhook_deliveries
      WHERE webhook_id = ${webhookId}
      ORDER BY created_at DESC
      LIMIT 1
    `.execute(db);

    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0]).toHaveProperty('id');
  });

  it('POST /api/webhooks/:id/test — test endpoint responds', async () => {
    const res = await fetch(`${BASE_URL}/api/webhooks/${webhookId}/test`, {
      method: 'POST',
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBeLessThan(500);
  });

  it('inactive webhook does NOT trigger on insert', async () => {
    // Delete any existing deliveries for the inactive webhook
    await sql`DELETE FROM zvd_webhook_deliveries WHERE webhook_id = ${inactiveWebhookId}`.execute(db);

    // Insert a record
    await fetch(`${BASE_URL}/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: godCookie },
      body: JSON.stringify({ title: 'Should not trigger inactive webhook' }),
    });

    // Wait briefly and confirm no delivery was created
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await sql<{ id: string }>`
      SELECT id FROM zvd_webhook_deliveries WHERE webhook_id = ${inactiveWebhookId} LIMIT 1
    `.execute(db);

    expect(rows.rows.length).toBe(0);
  }, 10_000);
});
