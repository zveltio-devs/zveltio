/**
 * `/api/edge-functions` is the engine's again: the developer/edge-functions
 * extension that held the CRUD was retired and its routes moved here.
 *
 * Pinned: a tenant admin can create, list, read, update and delete; a member
 * cannot; an `egress` change and a delete are audited with who did them; an
 * egress entry the runner would never match is refused at the door.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const NAME = `adm-${Date.now()}${Math.floor(Math.random() * 1e4)}`;

d('edge function administration (in-process)', () => {
  let app: Hono;
  let db: Database;
  let admin: string;
  let member: string;
  let id: string;

  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(`/api/edge-functions${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    admin = await createGodSession(app, db);
    member = (await createMemberSession(app, db)).cookie;
  });

  afterAll(async () => {
    if (db) await sql`DELETE FROM zv_edge_functions WHERE name = ${NAME}`.execute(db);
  });

  it('refuses anonymous callers and members', async () => {
    expect((await app.request('/api/edge-functions')).status).toBe(401);
    expect((await call(member, 'GET', '')).status).toBe(403);
    expect((await call(member, 'POST', '', { name: NAME })).status).toBe(403);
  });

  it('refuses an egress host the URL parser spells differently', async () => {
    const res = await call(admin, 'POST', '', { name: NAME, egress: ['127.1'] });
    expect(res.status).toBe(400);
  });

  it('creates a function served at /api/fn/:name, display name defaulting to its name', async () => {
    const res = await call(admin, 'POST', '', { name: NAME });
    expect(res.status).toBe(201);
    const { function: fn } = (await res.json()) as { function: Record<string, unknown> };
    id = String(fn.id);
    expect(fn.path).toBe(`/api/fn/${NAME}`);
    expect(fn.display_name).toBe(NAME);
    expect(String(fn.code)).toContain('export default');

    const list = (await (await call(admin, 'GET', '')).json()) as { functions: { id: string }[] };
    expect(list.functions.some((f) => f.id === id)).toBe(true);
    expect((await call(admin, 'GET', `/${id}`)).status).toBe(200);
  });

  it('audits an egress change with before and after', async () => {
    const res = await call(admin, 'PATCH', `/${id}`, {
      egress: ['api.example.com'],
      is_active: false,
    });
    expect(res.status).toBe(200);
    const { function: fn } = (await res.json()) as { function: Record<string, unknown> };
    expect(fn.egress).toEqual(['api.example.com']);
    expect(fn.is_active).toBe(false);
    expect(fn).not.toHaveProperty('egress_before');

    const row = await sql<{ metadata: { before: unknown; after: unknown } }>`
      SELECT metadata FROM zv_audit_log
       WHERE event_type = 'edge_function.egress_changed' AND resource_id = ${id}`.execute(db);
    expect(row.rows[0]?.metadata).toMatchObject({ before: null, after: ['api.example.com'] });
  });

  it('deletes, audits it, and answers 404 for a function that is gone', async () => {
    expect((await call(admin, 'DELETE', `/${id}`)).status).toBe(200);
    const row = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log
       WHERE event_type = 'edge_function.deleted' AND resource_id = ${id}`.execute(db);
    expect(row.rows[0]?.n).toBe(1);
    expect((await call(admin, 'DELETE', `/${id}`)).status).toBe(404);
    expect((await call(admin, 'GET', `/${id}`)).status).toBe(404);
  });
});
