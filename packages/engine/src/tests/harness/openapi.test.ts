/**
 * Phase C — /api/openapi.json spec generation (routes/openapi.ts).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('OpenAPI spec route (in-process)', () => {
  let app: Hono;
  let cookie: string;

  beforeAll(async () => {
    const ctx = await getTestApp();
    app = ctx.app;
    cookie = await createGodSession(app, ctx.db);
  });

  it('GET /api/openapi.json returns the OpenAPI document', async () => {
    const res = await app.request('/api/openapi.json', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(body.openapi).toBe('3.1.0');
    expect(typeof body.paths).toBe('object');
    expect(body.paths?.['/health']).toBeDefined();
  });

  it('includes core data routes in the spec', async () => {
    const res = await app.request('/api/openapi.json', { headers: { cookie } });
    const body = (await res.json()) as { paths?: Record<string, unknown> };
    const paths = Object.keys(body.paths ?? {});
    expect(paths.some((p) => p.includes('/data'))).toBe(true);
  });
});
