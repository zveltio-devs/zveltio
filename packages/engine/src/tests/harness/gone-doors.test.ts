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

d('gone dual doors (media + approvals + briefing + export/import + templates)', () => {
  let app: Hono;

  beforeAll(async () => {
    ({ app } = await getTestApp());
  });

  it('GET /api/media returns 410 with the storage replacement', async () => {
    const res = await app.request('/api/media/folders');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { errors?: { replacement?: string }; detail?: string };
    expect(body.errors?.replacement ?? '').toBe('/api/storage');
    expect(body.detail ?? '').toMatch(/\/api\/storage/);
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

  it('/api/templates returns 410: the templates are templates/* extensions (ADR 0049)', async () => {
    for (const [method, path] of [
      ['GET', '/api/templates'],
      ['POST', '/api/templates/helpdesk/install'],
    ]) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(410);
      const body = (await res.json()) as { errors?: { replacement?: string } };
      expect(body.errors?.replacement ?? '').toBe('/api/marketplace');
    }
  });

  it('GET /api/import/jobs returns 410 with data/import replacement', async () => {
    const res = await app.request('/api/import/jobs');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { errors?: { replacement?: string }; detail?: string };
    expect(body.errors?.replacement ?? '').toBe('/ext/data/import');
    expect(body.detail ?? '').toMatch(/data\/import/);
  });
});
