/**
 * Phase C — webhook deliveries on data update and delete (webhooks.ts + write-pipeline).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hwhud_${Date.now()}`;

d('webhook update + delete via data writes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let webhookId: string;
  let recordId: string;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => 'ok' }) as Response) as unknown as typeof fetch;

    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    const wh = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `Harness WH UD ${Date.now()}`,
        url: 'https://example.test/hook-ud',
        events: ['insert', 'update', 'delete'],
        collections: [COLLECTION],
      }),
    });
    const whBody = (await wh.json()) as { id?: string; webhook?: { id: string } };
    webhookId = whBody.id ?? whBody.webhook!.id;

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Webhook UD seed' }),
    });
    expect([200, 201]).toContain(create.status);
    const rec = (await create.json()) as { id: string };
    recordId = rec.id ?? (rec as { data?: { id: string } }).data!.id;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (!db) return;
    if (webhookId) {
      await sql`DELETE FROM zvd_webhook_deliveries WHERE webhook_id = ${webhookId}`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zvd_webhooks WHERE id = ${webhookId}`.execute(db).catch(() => {});
    }
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  const deliveryCount = async () => {
    const row = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM zvd_webhook_deliveries WHERE webhook_id = ${webhookId}
    `.execute(db);
    return Number(row.rows[0]?.count ?? 0);
  };

  it('PATCH /api/data/:collection/:id enqueues an update delivery', async () => {
    const before = await deliveryCount();
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Updated title' }),
    });
    expect([200, 204]).toContain(res.status);
    await new Promise((r) => setTimeout(r, 300));
    expect(await deliveryCount()).toBeGreaterThan(before);
  });

  it('DELETE /api/data/:collection/:id enqueues a delete delivery', async () => {
    const before = await deliveryCount();
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
    await new Promise((r) => setTimeout(r, 300));
    expect(await deliveryCount()).toBeGreaterThan(before);
  });
});
