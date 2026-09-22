/**
 * The virtual-source probe dials from the ENGINE, behind the SSRF guard.
 *
 * The Studio used to run this check in the browser — `fetch(source_url)` with
 * the typed credential in the header. That reached the administrator's own
 * network rather than the engine's, validated nothing, and handed the token to
 * whatever host had been typed. `POST /api/collections/virtual-test` runs the
 * same adapter the collection will use, so `safeFetch` refuses a private
 * address here exactly as it would once the collection existed.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('POST /api/collections/virtual-test', () => {
  let app: Hono;
  let cookie: string;

  beforeAll(async () => {
    let db: Database;
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('refuses a private address instead of dialling it', async () => {
    const res = await app.request('/api/collections/virtual-test', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        source_url: 'http://169.254.169.254/latest/meta-data/',
        auth_type: 'bearer',
        auth_value: 'a-token-that-must-not-leave',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error ?? '').toMatch(/private|blocked|not allowed|refus|internal/i);
  });

  it('requires a session', async () => {
    const res = await app.request('/api/collections/virtual-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_url: 'https://example.com' }),
    });
    expect([401, 403]).toContain(res.status);
  });
});
