/**
 * Phase C — flows (workflow automation) tenant isolation. Regression: zv_flows had
 * no tenant_id and routes/flows.ts listed all flows and reached them by id on the
 * raw pool db, so in a multi-tenant deployment any admin could enumerate, read,
 * patch, delete or run another tenant's flows by id (cross-tenant IDOR). Child rows
 * (steps / runs / dlq) are reached through the flow, so scoping the flow (and joining
 * the child reads) protects them too.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const FOREIGN_ID = '00000000-0000-4000-8000-0000000000fa';
const FOREIGN_RUN_ID = '00000000-0000-4000-8000-0000000000fb';
const STAMP = Date.now();

d('flows tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let myId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // A flow (+ run) belonging to ANOTHER tenant, inserted directly.
    await db
      .insertInto('zv_flows')
      .values({
        id: FOREIGN_ID,
        name: `foreign-flow-${STAMP}`,
        trigger_type: 'manual',
        is_active: true,
        tenant_id: OTHER_TENANT,
      })
      .execute();
    await db
      .insertInto('zv_flow_runs')
      .values({ id: FOREIGN_RUN_ID, flow_id: FOREIGN_ID, status: 'success' })
      .execute();
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${FOREIGN_ID}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_flows WHERE id = ${FOREIGN_ID}`.execute(db).catch(() => {});
    if (myId) await sql`DELETE FROM zv_flows WHERE id = ${myId}`.execute(db).catch(() => {});
  });

  it('single-tenant: create + list works and hides the other tenant’s flow', async () => {
    const create = await app.request(
      '/api/flows',
      json('POST', { name: `mine-${STAMP}`, trigger: { type: 'manual' }, steps: [] }),
    );
    expect(create.status).toBe(201);
    myId = ((await create.json()) as { flow: { id: string } }).flow.id;

    const list = await app.request('/api/flows', { headers: { cookie } });
    expect(list.status).toBe(200);
    const ids = ((await list.json()) as { flows: { id: string }[] }).flows.map((x) => x.id);
    expect(ids).toContain(myId);
    // the other tenant's flow must NOT leak into this tenant's list
    expect(ids).not.toContain(FOREIGN_ID);
  });

  it('cross-tenant: GET /:id of another tenant’s flow → 404', async () => {
    const res = await app.request(`/api/flows/${FOREIGN_ID}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('cross-tenant: PATCH /:id does not modify another tenant’s flow', async () => {
    const res = await app.request(`/api/flows/${FOREIGN_ID}`, json('PATCH', { name: 'hijacked' }));
    expect(res.status).toBe(404);
    const still = await db
      .selectFrom('zv_flows')
      .select('name')
      .where('id', '=', FOREIGN_ID)
      .executeTakeFirst();
    expect(still?.name).toBe(`foreign-flow-${STAMP}`); // untouched
  });

  it('cross-tenant: POST /:id/run does not run another tenant’s flow', async () => {
    const res = await app.request(`/api/flows/${FOREIGN_ID}/run`, json('POST', {}));
    expect(res.status).toBe(404);
  });

  it('cross-tenant: GET /:id/runs of another tenant’s flow is empty', async () => {
    const res = await app.request(`/api/flows/${FOREIGN_ID}/runs`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const runs = ((await res.json()) as { runs: { id: string }[] }).runs;
    expect(runs.map((r) => r.id)).not.toContain(FOREIGN_RUN_ID);
  });

  it('cross-tenant: GET /runs/:runId of another tenant’s run → 404', async () => {
    const res = await app.request(`/api/flows/runs/${FOREIGN_RUN_ID}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('cross-tenant: DELETE /:id does not remove another tenant’s flow', async () => {
    const res = await app.request(`/api/flows/${FOREIGN_ID}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    const still = await db
      .selectFrom('zv_flows')
      .select('id')
      .where('id', '=', FOREIGN_ID)
      .executeTakeFirst();
    expect(still?.id).toBe(FOREIGN_ID); // untouched
  });
});
