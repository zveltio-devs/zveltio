/**
 * A revoked read kept flowing down an SSE stream that was already open.
 *
 * `GET /api/realtime/stream` checks read once, when the stream opens, and the
 * delivery loop in `broadcastDataEvent` cannot ask Casbin per write. The
 * WebSocket door got a sweep that re-checks open subscriptions after a policy
 * change; this door had none, so a member whose read was taken away went on
 * receiving every write to the collection for as long as the stream stayed up.
 *
 * Asserts on the subscription registry and on the body ending, not on frames
 * read from the body — see `_sseConnectionsForTests`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getEnforcer, invalidateAllPermissionCaches } from '../../lib/tenancy/index.js';
import {
  _sseConnectionsForTests,
  broadcastDataEvent,
  revalidateSseStreams,
} from '../../routes/realtime.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `sserev_${Date.now()}`;

d('an open SSE stream after a revoke', () => {
  let app: Hono;
  let db: Database;
  let god: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (db) await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  /** Open a stream as a fresh member holding read, and spy on what it is sent. */
  async function openStream() {
    const member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection: COLLECTION, actions: ['read'] }],
    });
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // `connected` — the handler has registered the subscription
    const sub = [..._sseConnectionsForTests().get(member.userId)!][0]!;
    const delivered: string[] = [];
    const realWrite = sub.stream.writeSSE.bind(sub.stream);
    sub.stream.writeSSE = (msg: { data: string; event?: string }) => {
      delivered.push(msg.data);
      return realWrite(msg);
    };
    const send = (id: string) =>
      broadcastDataEvent(COLLECTION, 'insert', { id, title: id }, sub.tenantId);
    return { member, reader, delivered, send };
  }

  /** The sweep runs off the policy change, not inside the request; wait for it. */
  async function settle(done: () => boolean) {
    for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(10);
  }

  it('ends the stream when read is revoked through DELETE /policies', async () => {
    const { member, reader, delivered, send } = await openStream();
    send('before');
    expect(delivered.join('')).toContain('"before"');

    const res = await app.request('/api/permissions/policies', {
      method: 'DELETE',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: member.userId, resource: COLLECTION, action: 'read' }),
    });
    expect(res.status).toBe(200);
    await settle(() => !_sseConnectionsForTests().has(member.userId));

    delivered.length = 0;
    send('after');
    expect(delivered.join('')).not.toContain('"after"');
    expect(_sseConnectionsForTests().has(member.userId)).toBe(false);
    // The body ends (after the frames already queued, `before` among them), so
    // the client reconnects and meets the gate again.
    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  it('keeps a stream whose read still holds', async () => {
    const { member, reader, delivered, send } = await openStream();
    await invalidateAllPermissionCaches();
    // Give a wrongful close the same time the revoke case needed.
    await Bun.sleep(200);

    send('still');
    expect(delivered.join('')).toContain('"still"');
    expect(_sseConnectionsForTests().get(member.userId)?.size).toBe(1);
    await reader.cancel().catch(() => {});
  });

  it('keeps a stream whose re-check throws; the retry lands a revoke', async () => {
    const { member, reader, delivered, send } = await openStream();
    const e = await getEnforcer();
    const open = () => _sseConnectionsForTests().has(member.userId);
    try {
      // The policy lookup fails — an outage, not a revoke.
      e.getPolicy = async () => {
        throw new Error('policy lookup down');
      };
      await invalidateAllPermissionCaches();
      expect(await revalidateSseStreams()).toBe(true);
      expect(open()).toBe(true);

      // Revoked during the outage: that sweep fails too and schedules the retry.
      const res = await app.request('/api/permissions/policies', {
        method: 'DELETE',
        headers: { cookie: god, 'content-type': 'application/json' },
        body: JSON.stringify({ subject: member.userId, resource: COLLECTION, action: 'read' }),
      });
      expect(res.status).toBe(200);
      await Bun.sleep(100);
      expect(open()).toBe(true);

      // Lookups recover and no further policy change arrives: only the retry
      // sweep can end the stream now.
      Reflect.deleteProperty(e, 'getPolicy');
      for (let i = 0; i < 80 && open(); i++) await Bun.sleep(100);
      expect(open()).toBe(false);
      delivered.length = 0;
      send('after');
      expect(delivered.join('')).not.toContain('"after"');
    } finally {
      Reflect.deleteProperty(e, 'getPolicy');
      await reader.cancel().catch(() => {});
    }
  }, 15_000);
});
