/**
 * Dead dual doors must stay dead.
 *
 * Approvals and media live in extensions. Remounting full handlers under
 * /api/* recreated the audit failure mode (fix the engine copy, ship the
 * extension copy). These assertions pin the 410 shims.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('gone dual doors (media + approvals + briefing + export/import + edge CRUD)', () => {
  let app: Hono;

  beforeAll(async () => {
    ({ app } = await getTestApp());
  });

  it('GET /api/media returns 410 with extension replacement', async () => {
    const res = await app.request('/api/media/folders');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { errors?: { replacement?: string }; detail?: string };
    expect(body.errors?.replacement ?? '').toBe('/ext/content/media');
    expect(body.detail ?? '').toMatch(/content\/media/);
  });

  it('GET /api/approvals returns 410 with extension replacement', async () => {
    const res = await app.request('/api/approvals');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { errors?: { replacement?: string }; detail?: string };
    expect(body.errors?.replacement ?? '').toBe('/ext/workflow/approvals');
    expect(body.detail ?? '').toMatch(/workflow\/approvals/);
  });

  it('GET /api/briefing returns 410 with CRM replacement', async () => {
    const res = await app.request('/api/briefing');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { errors?: { replacement?: string }; detail?: string };
    expect(body.errors?.replacement ?? '').toBe('/ext/crm/briefing');
    expect(body.detail ?? '').toMatch(/crm\/briefing/);
  });

  it('GET /api/export returns 410 with data/export replacement', async () => {
    const res = await app.request('/api/export/posts');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { errors?: { replacement?: string }; detail?: string };
    expect(body.errors?.replacement ?? '').toBe('/ext/data/export');
    expect(body.detail ?? '').toMatch(/data\/export/);
  });

  it('GET /api/edge-functions returns 410 with the extension replacement', async () => {
    // `/api/fn` stays the engine's — only CRUD moved. The two are easy to
    // confuse, and pinning the shim here is what keeps them apart.
    const res = await app.request('/api/edge-functions');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { errors?: { replacement?: string }; detail?: string };
    expect(body.errors?.replacement ?? '').toBe('/ext/developer/edge-functions');
  });

  it('GET /api/import/jobs returns 410 with data/import replacement', async () => {
    const res = await app.request('/api/import/jobs');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { errors?: { replacement?: string }; detail?: string };
    expect(body.errors?.replacement ?? '').toBe('/ext/data/import');
    expect(body.detail ?? '').toMatch(/data\/import/);
  });
});
