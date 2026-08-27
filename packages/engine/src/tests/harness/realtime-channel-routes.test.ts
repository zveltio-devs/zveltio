/**
 * The presence and broadcast routes, which nothing was driving.
 *
 * `tenant-adversarial` walks the OpenAPI spec aiming each route at another
 * tenant's id, and it skips every route whose parameters it cannot synthesise —
 * `{channel}` among them. Four realtime routes were therefore outside the one
 * probe that looks for cross-tenant reachability, and the route bodies
 * themselves sat at 40% line coverage.
 *
 * Isolation here is by key construction rather than by a WHERE clause:
 * `presenceKey()` builds `presence:<tenantId>:<channel>` and `busChannel()`
 * builds `t:<tenantId>:<channel>`, so the same channel name in two tenants is
 * two different keys. That is what the last test drives.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const CHANNEL = `audit-presence-${STAMP}`;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000fe';
const OTHER_SLUG = `audit-other-${STAMP}`;

d('realtime presence + broadcast routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await sql`
      INSERT INTO zv_tenants (id, name, slug, status)
      VALUES (${OTHER_TENANT}::uuid, ${`Other Co ${STAMP}`}, ${OTHER_SLUG}, 'active')
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await app.request(`/api/realtime/presence/${CHANNEL}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER_TENANT}::uuid`.execute(db);
  });

  it('joining a presence channel reports the member back', async () => {
    const res = await app.request(`/api/realtime/presence/${CHANNEL}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: { status: 'auditing' } }),
    });
    expect([200, 201]).toContain(res.status);
  });

  it('listing the channel shows the member that joined', async () => {
    const res = await app.request(`/api/realtime/presence/${CHANNEL}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members?: unknown[]; count?: number };
    const members = body.members ?? [];
    expect(Array.isArray(members)).toBe(true);
    expect(members.length).toBeGreaterThan(0);
  });

  it('a channel nobody joined is empty rather than an error', async () => {
    const res = await app.request(`/api/realtime/presence/never-joined-${STAMP}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members?: unknown[] };
    expect(body.members ?? []).toEqual([]);
  });

  it('broadcasting to a channel is accepted', async () => {
    const res = await app.request(`/api/realtime/broadcast/${CHANNEL}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'audit.ping', payload: { at: STAMP } }),
    });
    expect([200, 202]).toContain(res.status);
  });

  it('reports live connections', async () => {
    const res = await app.request('/api/realtime/connections', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  it('leaving the channel removes the member', async () => {
    const leave = await app.request(`/api/realtime/presence/${CHANNEL}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect([200, 204]).toContain(leave.status);

    const after = await app.request(`/api/realtime/presence/${CHANNEL}`, {
      headers: { Cookie: cookie },
    });
    const body = (await after.json()) as { members?: unknown[] };
    expect(body.members ?? []).toEqual([]);
  });

  it('the same channel name in another tenant is a different channel', async () => {
    await app.request(`/api/realtime/presence/${CHANNEL}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: { status: 'auditing' } }),
    });

    const mine = await app.request(`/api/realtime/presence/${CHANNEL}`, {
      headers: { Cookie: cookie },
    });
    const mineBody = (await mine.json()) as { members?: unknown[] };
    expect((mineBody.members ?? []).length).toBeGreaterThan(0);

    const theirs = await app.request(`/api/realtime/presence/${CHANNEL}`, {
      headers: { Cookie: cookie, 'x-tenant-slug': OTHER_SLUG },
    });
    expect(theirs.status).toBe(200);
    const theirsBody = (await theirs.json()) as { members?: unknown[] };
    expect(theirsBody.members ?? []).toEqual([]);
  });
});
