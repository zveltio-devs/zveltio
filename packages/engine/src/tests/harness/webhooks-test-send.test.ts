/**
 * POST /api/webhooks/:id/test sends what a real delivery sends (B08).
 *
 * The route kept its own copy of the delivery: another blocked-header list,
 * its own signing and an unbounded fetch. A test dropped `x-api-key`, which
 * every real delivery carries, so the receiver refused the test and accepted
 * the events. It now goes through `WebhookManager.deliver`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';

const d = harnessAvailable() ? describe : describe.skip;

d('POST /api/webhooks/:id/test', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let id = '';
  let secret = '';
  const original = globalThis.fetch;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const res = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `test-send-${Date.now()}`,
        // An address, so no name is resolved: safeFetch pins it as is.
        url: 'https://93.184.216.34/hook',
        events: ['insert'],
        headers: { 'x-api-key': 'k-123', authorization: 'Bearer never-sent' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { webhook: { id: string }; secret: string };
    id = body.webhook.id;
    secret = body.secret;
  });

  afterAll(async () => {
    globalThis.fetch = original;
    // In the tenant: with no tenant context RLS shows a non-superuser owner no
    // row (DR-03), so a bare DELETE removed nothing and the hook — every insert,
    // every collection — doubled the jobs the pg-boss suites count.
    if (id) {
      await withTenantIsolation(DEFAULT_TENANT_ID, (trx) =>
        sql`DELETE FROM zvd_webhooks WHERE id = ${id}::uuid`.execute(trx),
      );
    }
  });

  const send = async (status: number) => {
    let seen: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input, init);
      return new Response('nope', { status });
    }) as typeof fetch;
    try {
      const res = await app.request(`/api/webhooks/${id}/test`, {
        method: 'POST',
        headers: { cookie },
      });
      return { res, seen: seen! };
    } finally {
      globalThis.fetch = original;
    }
  };

  it('carries the headers a delivery carries, signed with the secret', async () => {
    const { res, seen } = await send(200);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, status: 200 });
    expect(seen.headers.get('x-api-key')).toBe('k-123');
    expect(seen.headers.get('authorization')).toBeNull();

    const body = await seen.text();
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
    );
    expect(seen.headers.get('x-zveltio-signature')).toBe(
      `sha256=${Buffer.from(mac).toString('hex')}`,
    );
    expect(JSON.parse(body)).toMatchObject({ event: 'test', collection: 'test', sequence: 0 });
  });

  it('answers success false with the receiver’s status when it refuses', async () => {
    const { res } = await send(401);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: false, status: 401 });
  });
});
