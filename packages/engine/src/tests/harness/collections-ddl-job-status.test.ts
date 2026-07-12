/**
 * Phase C — GET /api/collections/jobs/:jobId (ddl-queue getDDLJob + mapJobToPublic).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hjob_${Date.now()}`;

d('collections DDL job status route (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('GET /jobs/:jobId returns completed create_collection job metadata', async () => {
    const create = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: COLLECTION,
        fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
      }),
    });
    expect(create.status).toBe(202);
    const body = (await create.json()) as { job_id?: string };
    expect(body.job_id).toBeDefined();
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(true);

    const jobRes = await app.request(`/api/collections/jobs/${body.job_id}`, {
      headers: { cookie },
    });
    expect(jobRes.status).toBe(200);
    const jobBody = (await jobRes.json()) as {
      job?: { id: string; type: string; status: string };
    };
    expect(jobBody.job?.id).toBe(body.job_id);
    expect(jobBody.job?.type).toBe('create_collection');
    expect(['completed', 'pending', 'running']).toContain(jobBody.job?.status ?? '');
  });

  it('GET /jobs/:jobId returns 404 for unknown ids', async () => {
    const res = await app.request('/api/collections/jobs/00000000-0000-0000-0000-000000000099', {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
