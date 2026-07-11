/**
 * Phase C — /api/templates (routes/templates.ts + DDL queue enqueue paths).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PREFIX = `htpl_${Date.now()}`;

d('templates routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    const rows = await db
      .selectFrom('zvd_collections')
      .select('name')
      .where('name', 'like', `${PREFIX}_%`)
      .execute()
      .catch(() => []);
    for (const row of rows) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${row.name}" CASCADE`)
        .execute(db)
        .catch(() => {});
    }
    await db
      .deleteFrom('zvd_collections')
      .where('name', 'like', `${PREFIX}_%`)
      .execute()
      .catch(() => {});
  });

  it('GET /api/templates lists builtin template summaries', async () => {
    const res = await app.request('/api/templates', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: Array<{ id: string }> };
    expect(body.templates.length).toBeGreaterThan(0);
    expect(body.templates.some((t) => t.id === 'crm')).toBe(true);
  });

  it('GET /api/templates/:id returns a full manifest', async () => {
    const res = await app.request('/api/templates/crm', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: { id: string; collections: unknown[] } };
    expect(body.template.id).toBe('crm');
    expect(body.template.collections.length).toBeGreaterThan(0);
  });

  it('POST /api/templates/:id/install enqueues DDL jobs with a prefix', async () => {
    const res = await app.request('/api/templates/crm/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ prefix: PREFIX, skip_existing: true }),
    });
    expect([200, 202]).toContain(res.status);
    const body = (await res.json()) as { jobs?: unknown[]; job_ids?: string[] };
    const jobs = body.jobs ?? body.job_ids ?? [];
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('rejects unauthenticated template listing', async () => {
    const res = await app.request('/api/templates');
    expect([401, 403]).toContain(res.status);
  });
});
