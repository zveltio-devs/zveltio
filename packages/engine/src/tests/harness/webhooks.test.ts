/**
 * Phase C — webhooks routes driven through the in-process app.
 *
 * Full CRUD lifecycle over /api/webhooks: create → list → get → patch →
 * deliveries → rotate-secret → delete → 404, plus the unauth guard. Fully
 * DB-backed. The created webhook is deleted through the route (and defensively
 * in afterAll).
 *
 * Skips without a test database.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('webhooks routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let id: string | undefined;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db && id) {
      await sql`DELETE FROM zv_webhooks WHERE id = ${id}`.execute(db).catch(() => {});
    }
  });

  it('POST / creates a webhook', async () => {
    const res = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `harness-wh-${Date.now()}`,
        url: 'https://example.test/hook',
        events: ['record.created'],
      }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { id?: string; webhook?: { id: string } };
    id = body.id ?? body.webhook?.id;
    expect(id).toBeDefined();
  });

  it('GET / lists webhooks including the new one', async () => {
    const res = await app.request('/api/webhooks', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : ((body as { webhooks?: unknown[] }).webhooks ?? []);
    expect((rows as Array<{ id: string }>).some((r) => r.id === id)).toBe(true);
  });

  it('GET /:id returns the webhook', async () => {
    const res = await app.request(`/api/webhooks/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string; webhook?: { url: string } };
    expect((body.webhook ?? body).url).toBe('https://example.test/hook');
  });

  it('PATCH /:id updates the webhook', async () => {
    const res = await app.request(`/api/webhooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'renamed-wh' }),
    });
    expect([200, 204]).toContain(res.status);
  });

  it('GET /:id/deliveries returns the delivery log', async () => {
    const res = await app.request(`/api/webhooks/${id}/deliveries`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = Array.isArray(body)
      ? body
      : ((body as { deliveries?: unknown[] }).deliveries ?? []);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('POST /:id/rotate-secret rotates the signing secret', async () => {
    const res = await app.request(`/api/webhooks/${id}/rotate-secret`, {
      method: 'POST',
      headers: { cookie },
    });
    expect([200, 201, 204]).toContain(res.status);
  });

  it('DELETE /:id removes the webhook, then GET 404s', async () => {
    const del = await app.request(`/api/webhooks/${id}`, { method: 'DELETE', headers: { cookie } });
    expect([200, 204]).toContain(del.status);
    const gone = await app.request(`/api/webhooks/${id}`, { headers: { cookie } });
    expect(gone.status).toBe(404);
    id = undefined; // already deleted
  });

  it('rejects unauthenticated webhook listing', async () => {
    const res = await app.request('/api/webhooks');
    expect([401, 403]).toContain(res.status);
  });
});
