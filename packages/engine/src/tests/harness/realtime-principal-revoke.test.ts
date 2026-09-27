/**
 * A socket or stream outlived the credential it opened with.
 *
 * `/api/ws` and `/api/realtime/stream` authenticate once, at open, and the
 * sweep that re-checks open connections (`revalidateSockets`) asked only about
 * per-collection permissions — which a signed-out, deactivated or deleted user
 * may still hold, and which an API key's scopes still name after the key is
 * revoked. So the connection stayed up and kept receiving writes.
 *
 * Driven the way a client and an administrator drive it: the real upgrade, the
 * real handlers, and the revocation through `ctx.internals` inside a request
 * transaction, the admin API, or better-auth's own sign-out.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import {
  ACCESS_RULES_CHANGED_EVENT,
  dispatchToWs,
  realtimeBus,
  type RealtimeBusMessage,
} from '../../lib/runtime/index.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { __sweepIdle, revalidateSockets } from '../../lib/tenancy/index.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { _wsPermCacheForTests, broadcastEvent, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const COLLECTION = `wsprin_${Date.now()}`;

d('an open realtime connection after its principal is revoked', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  const probes: string[] = [];
  const keyIds: string[] = [];
  const internals = gateInternals('auth/scim', buildExtensionInternals(), ['auth:users']);
  const asRequest = <T>(fn: (trx: Database) => Promise<T>) =>
    buildExtensionInternals().withTenantIsolation(TENANT, fn);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    const { connections } = _wsPermCacheForTests();
    for (const id of probes) connections.delete(id);
    if (!db) return;
    if (keyIds.length > 0) await db.deleteFrom('zv_api_keys').where('id', 'in', keyIds).execute();
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  const member = () =>
    createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection: COLLECTION, actions: ['read'] }],
    });

  /** A socket opened through the real upgrade and subscribed to COLLECTION. */
  async function openWs(headers: Record<string, string>) {
    const data = await wsUpgradeData(app, headers);
    expect(data).toBeDefined();
    const id = `ws_prin_${probes.length}_${Date.now()}`;
    probes.push(id);
    const sent: string[] = [];
    let closed: { code: number; reason: string } | null = null;
    const ws = {
      data: { ...data, id },
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
    const isOpen = () => _wsPermCacheForTests().connections.has(id);
    // The tenant the upgrade captured: fan-out is scoped to it.
    const tenantId = (data?.tenantId as string | null) ?? null;
    const send = (rid: string) =>
      broadcastEvent(COLLECTION, 'insert', { id: rid, title: rid }, tenantId);
    return { sent, closed: () => closed, isOpen, send };
  }

  /** The sweep runs off the revocation (after its commit); wait for it. */
  async function settle(done: () => boolean) {
    for (let i = 0; i < 150 && !done(); i++) await Bun.sleep(20);
    await __sweepIdle();
  }

  async function createKey(): Promise<{ id: string; key: string }> {
    const res = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        name: `ws principal ${Date.now()}`,
        scopes: [{ collection: COLLECTION, actions: ['read'] }],
      }),
    });
    expect(res.status).toBe(200);
    const key = (await res.json()) as { id: string; key: string };
    keyIds.push(key.id);
    return key;
  }

  function expectClosed(socket: Awaited<ReturnType<typeof openWs>>) {
    expect(socket.closed()).toEqual({ code: 4001, reason: 'Unauthorized' });
    expect(socket.isOpen()).toBe(false);
    socket.sent.length = 0;
    socket.send('after');
    expect(socket.sent.join('')).not.toContain('"after"');
  }

  it('closes a session socket after revokeUserSessions, and keeps a bystander', async () => {
    const target = await member();
    const bystander = await member();
    const gone = await openWs({ cookie: target.cookie });
    const kept = await openWs({ cookie: bystander.cookie });

    await asRequest(() => internals.revokeUserSessions(target.userId));
    await settle(() => gone.closed() !== null);

    expectClosed(gone);
    expect(kept.closed()).toBeNull();
    expect(kept.isOpen()).toBe(true);
    kept.sent.length = 0;
    kept.send('still');
    expect(kept.sent.join('')).toContain('"still"');
  });

  it('closes a session socket after setUserActive(false)', async () => {
    const target = await member();
    const socket = await openWs({ cookie: target.cookie });
    await asRequest((trx) => internals.setUserActive(trx, target.userId, false));
    await settle(() => socket.closed() !== null);
    expectClosed(socket);
  });

  it('closes a session socket after deleteUser', async () => {
    const target = await member();
    const socket = await openWs({ cookie: target.cookie });
    await asRequest((trx) =>
      internals.deleteUser(trx, target.userId, { actor: 'scim:t', reason: 'scim.deprovision' }),
    );
    await settle(() => socket.closed() !== null);
    expectClosed(socket);
  });

  it('closes a session socket after better-auth sign-out', async () => {
    const target = await member();
    const socket = await openWs({ cookie: target.cookie });
    const res = await app.request('/api/auth/sign-out', {
      method: 'POST',
      headers: { cookie: target.cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    await settle(() => socket.closed() !== null);
    expectClosed(socket);
  });

  it('closes an API-key socket after the key is revoked', async () => {
    const { id, key } = await createKey();
    const socket = await openWs({ 'X-API-Key': key });
    const res = await app.request(`/api/api-keys/${id}`, {
      method: 'DELETE',
      headers: { cookie: god },
    });
    expect(res.status).toBe(200);
    await settle(() => socket.closed() !== null);
    expectClosed(socket);
  });

  it('closes an API-key socket after the key creator is deactivated', async () => {
    const creator = await member();
    const { id, key } = await createKey();
    await sql`UPDATE zv_api_keys SET created_by = ${creator.userId} WHERE id = ${id}`.execute(db);
    const socket = await openWs({ 'X-API-Key': key });
    await asRequest((trx) => internals.setUserActive(trx, creator.userId, false));
    await settle(() => socket.closed() !== null);
    expectClosed(socket);
  });

  it('a key narrowed by PATCH stops receiving the collection it lost', async () => {
    const { id, key } = await createKey();
    const socket = await openWs({ 'X-API-Key': key });
    socket.sent.length = 0;
    socket.send('before');
    expect(socket.sent.join('')).toContain('"before"');

    const res = await app.request(`/api/admin/api-keys/${id}`, {
      method: 'PATCH',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({
        scopes: [{ collection: 'some_other_collection', actions: ['read'] }],
      }),
    });
    expect(res.status).toBe(200);
    await settle(() => socket.sent.some((m) => m.includes('"unsubscribed"')));

    // Trimmed like any other lost read, not closed: the key still authenticates.
    expect(socket.sent.join('')).toContain('"reason":"forbidden"');
    expect(socket.closed()).toBeNull();
    expect(socket.isOpen()).toBe(true);
    socket.sent.length = 0;
    socket.send('after');
    expect(socket.sent.join('')).not.toContain('"after"');
  });

  it('the periodic principal sweep closes an expired session and an expired key', async () => {
    const target = await member();
    const session = await openWs({ cookie: target.cookie });
    const { id, key } = await createKey();
    const keyed = await openWs({ 'X-API-Key': key });
    // Expiry sends no event; only the reconcile tick's sweep can see it.
    await sql`UPDATE session SET "expiresAt" = NOW() - INTERVAL '1 minute'
               WHERE "userId" = ${target.userId}`.execute(db);
    await sql`UPDATE zv_api_keys SET expires_at = NOW() - INTERVAL '1 minute'
               WHERE id = ${id}`.execute(db);
    revalidateSockets('principals');
    await settle(() => session.closed() !== null && keyed.closed() !== null);
    expectClosed(session);
    expectClosed(keyed);
  });

  it('a revocation on another instance reaches this one through the bus', async () => {
    const bus = realtimeBus();
    const origPublish = bus.publish;
    const published: Array<Omit<RealtimeBusMessage, 'originId'>> = [];
    bus.publish = async (payload) => {
      published.push(payload);
    };
    try {
      // Instance A revokes.
      const target = await member();
      await asRequest(() => internals.revokeUserSessions(target.userId));
      await __sweepIdle();
      const msg = published.find(
        (m) =>
          m.event === ACCESS_RULES_CHANGED_EVENT &&
          (m.data as { scope?: string } | undefined)?.scope === 'principals',
      );
      expect(msg).toBeDefined();

      // Instance B holds a socket whose session A deleted, and nothing here swept.
      const other = await member();
      const socket = await openWs({ cookie: other.cookie });
      await sql`DELETE FROM session WHERE "userId" = ${other.userId}`.execute(db);
      await Bun.sleep(50);
      expect(socket.closed()).toBeNull();

      await dispatchToWs({ ...msg!, originId: 'replica-a' });
      await settle(() => socket.closed() !== null);
      expectClosed(socket);
    } finally {
      bus.publish = origPublish;
    }
  });

  it('ends an SSE stream after revokeUserSessions', async () => {
    const target = await member();
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { cookie: target.cookie },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // `connected` — the stream is registered
    expect(_sseConnectionsForTests().has(target.userId)).toBe(true);

    await asRequest(() => internals.revokeUserSessions(target.userId));
    await settle(() => !_sseConnectionsForTests().has(target.userId));

    expect(_sseConnectionsForTests().has(target.userId)).toBe(false);
    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
  });
});
