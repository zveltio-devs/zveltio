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

  // routes/openapi.ts: in production the spec is admin-only unless the
  // operator sets OPENAPI_PUBLIC=true (a registered mode, so the boot warns).
  async function inProduction(env: Record<string, string | undefined>, fn: () => Promise<void>) {
    const saved = { NODE_ENV: process.env.NODE_ENV, OPENAPI_PUBLIC: process.env.OPENAPI_PUBLIC };
    Object.assign(process.env, { NODE_ENV: 'production', OPENAPI_PUBLIC: undefined, ...env });
    if (process.env.OPENAPI_PUBLIC === undefined) delete process.env.OPENAPI_PUBLIC;
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('in production refuses an anonymous caller', async () => {
    await inProduction({}, async () => {
      const res = await app.request('/api/openapi.json');
      expect(res.status).toBe(401);
    });
  });

  it('in production serves anyone only with OPENAPI_PUBLIC=true', async () => {
    await inProduction({ OPENAPI_PUBLIC: 'TRUE' }, async () => {
      expect((await app.request('/api/openapi.json')).status).toBe(401);
    });
    await inProduction({ OPENAPI_PUBLIC: 'true' }, async () => {
      expect((await app.request('/api/openapi.json')).status).toBe(200);
    });
  });
});
