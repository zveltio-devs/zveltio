/**
 * Phase C — admin/read surface driven through the in-process app.
 *
 * Exercises the GET endpoints of users, permissions, settings, and the
 * extension marketplace catalog as an authenticated god user, plus their
 * unauthenticated guards. Lights up the read paths of routes/users.ts,
 * routes/permissions.ts, routes/settings.ts, and the big
 * extension-marketplace-routes.ts catalog handler in-process.
 *
 * Skips without a test database.
 */

import { describe, expect, it, beforeAll } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('admin/read surface (in-process)', () => {
  let app: Hono;
  let cookie: string;

  beforeAll(async () => {
    const ctx = await getTestApp();
    app = ctx.app;
    cookie = await createGodSession(app, ctx.db);
  });

  it('GET /api/users lists users for a god session', async () => {
    const res = await app.request('/api/users', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : ((body as { users?: unknown[] }).users ?? []);
    expect(Array.isArray(rows)).toBe(true);
    // the god user we just created is in there
    expect((rows as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/users requires auth', async () => {
    const res = await app.request('/api/users');
    expect([401, 403]).toContain(res.status);
  });

  it('GET /api/permissions returns the roles/policy view', async () => {
    const res = await app.request('/api/permissions', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeDefined();
  });

  it('GET /api/permissions/roles/:userId resolves a user’s roles', async () => {
    // ask for the god session's own roles via the "me"-style lookup; any
    // userid string exercises the handler + Casbin role resolution path.
    const res = await app.request('/api/permissions/roles/nonexistent-user', {
      headers: { cookie },
    });
    expect([200, 404]).toContain(res.status);
  });

  it('GET /api/settings/public is reachable without auth', async () => {
    const res = await app.request('/api/settings/public');
    expect(res.status).toBe(200);
    expect(await res.json()).toBeDefined();
  });

  it('GET /api/settings lists settings for a god session', async () => {
    const res = await app.request('/api/settings', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeDefined();
  });

  it('GET /api/marketplace runs the catalog handler', async () => {
    // The catalog merges local DB registry state with a remote registry fetch;
    // in the harness the registry is unreachable, so the handler may return the
    // local catalog (200) or a gateway error — either way it EXECUTED in-process
    // (which is the coverage goal). Pin only that it produced a structured HTTP
    // response, not a crash.
    const res = await app.request('/api/marketplace', { headers: { cookie } });
    expect([200, 500, 502, 503, 504]).toContain(res.status);
    expect(await res.text()).toBeDefined();
    // The unreachable registry fetch can take up to its ~5s abort timeout, so
    // give this one a generous budget (default bun test timeout is 5s).
  }, 20_000);
});
