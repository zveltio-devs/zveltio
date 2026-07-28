/**
 * Phase A coverage — health routes (routes/health.ts), mounted at /api/health.
 * Had no dedicated harness suite (58.8% incidental). `/` and `/ready` are
 * public; version/migrations/deep/update-check/:subsystem require a session.
 * All in-process + DB, no external service.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('health routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('GET /api/health is public and reports ok + demo_mode', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; demo_mode?: boolean };
    expect(body.status).toBe('ok');
    expect(typeof body.demo_mode).toBe('boolean');
  });

  it('GET /api/health/ready is public and returns a readiness verdict', async () => {
    const res = await app.request('/api/health/ready');
    // 200 ready or 503 not-ready are both valid, well-formed responses.
    expect([200, 503]).toContain(res.status);
  });

  it('GET /api/health/version → 401 anonymous, 200 with a session', async () => {
    const anon = await app.request('/api/health/version');
    expect(anon.status).toBe(401);
    const authed = await app.request('/api/health/version', { headers: { cookie } });
    expect(authed.status).toBe(200);
  });

  it('GET /api/health/migrations lists migration state (authed)', async () => {
    const res = await app.request('/api/health/migrations', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('GET /api/health/deep runs subsystem checks (authed)', async () => {
    const res = await app.request('/api/health/deep', { headers: { cookie } });
    // deep may report degraded subsystems (cache/S3 absent) but the endpoint
    // itself must respond cleanly, not 401/500.
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body).toBe('object');
  });

  it('GET /api/health/update-check responds (authed)', async () => {
    const res = await app.request('/api/health/update-check', { headers: { cookie } });
    // May reach out to the registry; any non-auth verdict is fine here.
    expect(res.status).not.toBe(401);
  });

  it('GET /api/health/:subsystem returns a single subsystem verdict (authed)', async () => {
    const res = await app.request('/api/health/database', { headers: { cookie } });
    expect([200, 404, 503]).toContain(res.status);
  });

  it('GET /api/health/deep → 401 anonymous', async () => {
    const res = await app.request('/api/health/deep');
    expect(res.status).toBe(401);
  });
});
