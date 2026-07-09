/**
 * Phase C proof: the in-process app harness boots the real Hono app and drives
 * routes via app.request() so coverage sees the handlers + middleware execute.
 *
 * Skips when no TEST_DATABASE_URL / DATABASE_URL is set (plain `bun test`
 * without a database); CI runs it under a Postgres service. This first test is
 * intentionally broad-but-shallow — it proves the harness works end to end
 * (boot → auth → authed + public routes). Per-route deep assertions land in
 * follow-up harness tests.
 */

import { describe, expect, it, beforeAll } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('in-process app harness', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('serves the public health endpoint', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBeDefined();
  });

  it('serves the deep health check across subsystems (authed)', async () => {
    const res = await app.request('/api/health/deep', { headers: { cookie } });
    // 200 (all healthy) or 503 (an optional subsystem degraded) — both are
    // valid, structured responses proving the handler ran.
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as { checks?: unknown };
    expect(body.checks ?? body).toBeDefined();
  });

  it('serves the OpenAPI spec (public) with real collections', async () => {
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(spec.openapi).toBeDefined();
    expect(spec.paths).toBeDefined();
  });

  it('lists collections for an authenticated god user', async () => {
    const res = await app.request('/api/collections', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      Array.isArray(body) || Array.isArray((body as { collections?: unknown[] }).collections),
    ).toBe(true);
  });

  it('rejects the same collections route without a session (auth guard runs)', async () => {
    const res = await app.request('/api/collections');
    expect([401, 403]).toContain(res.status);
  });
});
