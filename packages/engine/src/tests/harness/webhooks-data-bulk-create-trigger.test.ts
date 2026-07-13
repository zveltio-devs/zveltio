/**
 * Phase C — WebhookManager.trigger on bulk POST create (handlers/bulk.ts afterWrite loop).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hwhbulk_${Date.now()}`;

d('webhook trigger via bulk create (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let webhookId = '';
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
        name: `Harness WH bulk ${Date.now()}`,
        url: 'https://example.test/hook-bulk',
        events: ['insert'],
        collections: [COLLECTION],
      }),
    });
    const body = (await wh.json()) as { id?: string; webhook?: { id: string } };
    webhookId = body.id ?? body.webhook!.id;
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

  it('POST /api/data/:collection/bulk creates delivery rows for each inserted record', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [{ title: 'bulk-a' }, { title: 'bulk-b' }],
      }),
    });
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 300));

    const deliveries = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM zvd_webhook_deliveries WHERE webhook_id = ${webhookId}
    `.execute(db);
    expect(Number(deliveries.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(2);
  });
});
