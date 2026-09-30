/**
 * An open realtime connection after its tenant is archived or purged.
 *
 * `DELETE /api/tenants/:id` refuses the tenant's HTTP traffic from then on (the
 * tenant middleware answers 403 for a status other than 'active'), but a socket
 * or stream captures its tenant at open and the sweep re-asked only its session
 * or key — so it stayed up and kept receiving that tenant's writes, which
 * flows, the scheduler and extensions still broadcast.
 *
 * Driven through the real upgrade, the real `/stream` and the real DELETE route.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { __sweepIdle, DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { _wsPermCacheForTests, broadcastEvent, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const COLLECTION = `wsten_${SFX}`;
const mk = (tag: string) => ({ id: crypto.randomUUID(), slug: `wsten-${tag}-${SFX}` });
const ARCHIVED = mk('a');
const PURGED = mk('p');
const SUSPENDED = mk('s');

d('an open realtime connection after its tenant is archived or purged', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const probes: string[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (const t of [ARCHIVED, PURGED, SUSPENDED]) {
      await sql`INSERT INTO zv_tenants (id, slug, name) VALUES (${t.id}, ${t.slug}, 'wsten')`.execute(
        db,
      );
    }
  });

  afterAll(async () => {
    const { connections } = _wsPermCacheForTests();
    for (const id of probes) connections.delete(id);
    if (!db) return;
    await dropTestCollection(db, COLLECTION).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ANY (${[ARCHIVED.id, PURGED.id, SUSPENDED.id]})`
      .execute(db)
      .catch(() => {});
  });

  /** A socket opened through the real upgrade and subscribed to COLLECTION. */
  async function openWs(slug: string | null, override: Record<string, unknown> = {}) {
    const data = await wsUpgradeData(app, {
      cookie: god,
      ...(slug ? { 'x-tenant-slug': slug } : {}),
    });
    expect(data).toBeDefined();
    const id = `ws_ten_${probes.length}_${SFX}`;
    probes.push(id);
    const sent: string[] = [];
    let closed: { code: number; reason: string } | null = null;
    const ws = {
      data: { ...data, ...override, id },
      send: (p: string) => sent.push(p),
      close: (code: number, reason: string) => {
        closed = { code, reason };
      },
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    expect(sent.join('\n')).toContain('"type":"subscribed"');
    const tenantId = ((ws.data as Record<string, unknown>).tenantId as string | null) ?? null;
    const delivered = (rid: string) => {
      sent.length = 0;
      broadcastEvent(COLLECTION, 'insert', { id: rid, title: rid }, tenantId);
      return sent.join('').includes(`"${rid}"`);
    };
    return { tenantId, closed: () => closed, delivered };
  }

  async function openSse(slug: string) {
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { cookie: god, 'x-tenant-slug': slug },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // `connected` — the stream is registered
    return reader;
  }

  const sseOpen = (tenantId: string) =>
    [..._sseConnectionsForTests().values()].some((set) =>
      [...set].some((s) => s.tenantId === tenantId),
    );

  async function settle(done: () => boolean) {
    for (let i = 0; i < 150 && !done(); i++) await Bun.sleep(20);
    await __sweepIdle();
  }

  const del = (id: string, q: string) =>
    app.request(`/api/tenants/${id}?${q}`, { method: 'DELETE', headers: { cookie: god } });

  it('archive closes the tenant sockets and streams, and only those', async () => {
    const socket = await openWs(ARCHIVED.slug);
    expect(socket.tenantId).toBe(ARCHIVED.id);
    const reader = await openSse(ARCHIVED.slug);
    expect(sseOpen(ARCHIVED.id)).toBe(true);
    const bystander = await openWs(null);
    expect(bystander.tenantId).toBe(DEFAULT_TENANT_ID);
    // A single-tenant deployment captures no tenant; nothing to be archived.
    const untenanted = await openWs(null, { tenantId: null });
    expect(untenanted.tenantId).toBeNull();

    expect((await del(ARCHIVED.id, 'mode=archive')).status).toBe(200);
    await settle(() => socket.closed() !== null && !sseOpen(ARCHIVED.id));

    expect(socket.closed()).not.toBeNull();
    expect(socket.delivered('after-archive')).toBe(false);
    expect(sseOpen(ARCHIVED.id)).toBe(false);
    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);

    for (const kept of [bystander, untenanted]) {
      expect(kept.closed()).toBeNull();
      expect(kept.delivered('kept')).toBe(true);
    }
  }, 60_000);

  it('purge closes a socket its archive did not reach', async () => {
    const socket = await openWs(PURGED.slug);
    // Archived behind the engine's back — a raw edit, or a sweep that never ran.
    await sql`UPDATE zv_tenants SET status = 'deleted' WHERE id = ${PURGED.id}`.execute(db);
    expect(socket.delivered('before-purge')).toBe(true);

    expect((await del(PURGED.id, `mode=purge&confirm=${PURGED.slug}`)).status).toBe(200);
    await settle(() => socket.closed() !== null);

    expect(socket.closed()).not.toBeNull();
    expect(socket.delivered('after-purge')).toBe(false);
  }, 60_000);

  it('a PATCH that suspends the tenant closes its sockets too', async () => {
    const socket = await openWs(SUSPENDED.slug);
    const res = await app.request(`/api/tenants/${SUSPENDED.id}`, {
      method: 'PATCH',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    });
    expect(res.status).toBe(200);
    await settle(() => socket.closed() !== null);
    expect(socket.closed()).not.toBeNull();
    expect(socket.delivered('after-suspend')).toBe(false);
  }, 60_000);
});
