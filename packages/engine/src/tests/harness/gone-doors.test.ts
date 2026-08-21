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

d('gone dual doors (media + approvals + briefing)', () => {
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
});
