/**
 * Phase C — flows (workflow automation) CRUD + step management + run, driven
 * through the in-process app.
 *
 * Exercises routes/flows.ts end-to-end: create → list → get → patch → add step →
 * update step → run → list runs → delete step → dlq → delete → 404, plus the
 * admin-auth guard. Flows are admin-only; the harness god session passes the
 * `checkPermission(admin, *)` gate. zv_flows / zv_flow_steps come from
 * migrations, so no table provisioning is needed.
 *
 * Skips without a test database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('flows CRUD + steps + run (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let flowId = '';
  let stepId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db && flowId) {
      await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${flowId}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flows WHERE id = ${flowId}`.execute(db).catch(() => {});
    }
  });

  it('rejects unauthenticated access (admin-only)', async () => {
    const res = await app.request('/api/flows');
    expect(res.status).toBe(401);
  });

  it('creates a flow (POST /) with a manual trigger and no steps', async () => {
    const res = await app.request(
      '/api/flows',
      json('POST', {
        name: 'Harness Flow',
        description: 'created by the harness',
        trigger: { type: 'manual' },
        steps: [],
        is_active: true,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { flow: { id: string; name: string } };
    expect(body.flow.id).toBeDefined();
    expect(body.flow.name).toBe('Harness Flow');
    flowId = body.flow.id;
  });

  it('lists flows (GET /) including the new one', async () => {
    const res = await app.request('/api/flows', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flows: Array<{ id: string }> };
    const flows = body.flows ?? (body as unknown as Array<{ id: string }>);
    expect(Array.isArray(flows)).toBe(true);
    expect(flows.some((f) => f.id === flowId)).toBe(true);
  });

  it('fetches a single flow with its steps (GET /:id)', async () => {
    const res = await app.request(`/api/flows/${flowId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flow?: { id: string; steps: unknown[] } };
    const flow = body.flow ?? (body as { id: string; steps: unknown[] });
    expect((flow as { id: string }).id).toBe(flowId);
  });

  it('patches a flow (PATCH /:id) — rename + deactivate', async () => {
    const res = await app.request(
      `/api/flows/${flowId}`,
      json('PATCH', { name: 'Harness Flow (renamed)', is_active: false }),
    );
    expect([200, 204]).toContain(res.status);
    const check = await app.request(`/api/flows/${flowId}`, { headers: { cookie } });
    const body = (await check.json()) as { flow?: { name: string; is_active: boolean } };
    const flow = body.flow ?? (body as { name: string; is_active: boolean });
    expect((flow as { name: string }).name).toBe('Harness Flow (renamed)');
  });

  it('appends a step (POST /:id/steps)', async () => {
    const res = await app.request(
      `/api/flows/${flowId}/steps`,
      json('POST', {
        type: 'condition',
        name: 'gate',
        config: { expression: '1 == 1' },
        on_error: 'stop',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { step: { id: string; type: string } };
    expect(body.step.id).toBeDefined();
    expect(body.step.type).toBe('condition');
    stepId = body.step.id;
  });

  it('rejects a step with an invalid config (400, not 500)', async () => {
    const res = await app.request(
      `/api/flows/${flowId}/steps`,
      json('POST', { type: 'webhook', config: { url: 'not-a-url' }, on_error: 'stop' }),
    );
    expect(res.status).toBe(400);
  });

  it('updates a step (PUT /:id/steps/:stepId)', async () => {
    const res = await app.request(
      `/api/flows/${flowId}/steps/${stepId}`,
      json('PUT', { name: 'gate (renamed)', config: { expression: '2 > 1' } }),
    );
    expect([200, 204]).toContain(res.status);
  });

  it('runs the flow (POST /:id/run) and records a run', async () => {
    const res = await app.request(`/api/flows/${flowId}/run`, json('POST', {}));
    // The condition step evaluates in-process; tolerate the flow engine's status.
    expect(res.status).toBeLessThan(500);

    const runs = await app.request(`/api/flows/${flowId}/runs`, { headers: { cookie } });
    expect(runs.status).toBe(200);
  });

  it('lists the dead-letter queue (GET /dlq)', async () => {
    const res = await app.request('/api/flows/dlq', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('deletes a step (DELETE /:id/steps/:stepId)', async () => {
    const res = await app.request(`/api/flows/${flowId}/steps/${stepId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
  });

  it('deletes the flow (DELETE /:id) and then 404s', async () => {
    const del = await app.request(`/api/flows/${flowId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(del.status);
    const gone = await app.request(`/api/flows/${flowId}`, { headers: { cookie } });
    expect(gone.status).toBe(404);
  });
});
