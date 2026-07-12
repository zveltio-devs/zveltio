/**
 * Phase C — GET system collection detail (routes/collections.ts + getSystemCollection).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('collections system detail (in-process)', () => {
  let app: Hono;
  let cookie = '';

  beforeAll(async () => {
    const harness = await getTestApp();
    app = harness.app;
    cookie = await createGodSession(harness.app, harness.db);
  });

  it('GET /api/collections/user returns the Better-Auth system collection', async () => {
    const res = await app.request('/api/collections/user', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collection?: { name: string; is_system?: boolean; fields?: unknown[] };
    };
    expect(body.collection?.name).toBe('user');
    expect(body.collection?.is_system).toBe(true);
    expect(Array.isArray(body.collection?.fields)).toBe(true);
  });
});
