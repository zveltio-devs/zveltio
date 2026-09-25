/**
 * A change to a user's `"user".role` must reach every instance's open realtime
 * subscriptions, the writer's included.
 *
 * `invalidateUserPermCache` — what every role change calls — dropped the
 * caches and swept this instance's sockets, inside the request transaction and
 * with nothing published. So:
 *
 *   - the sweep read the role back before the UPDATE committed, and filed the
 *     OLD answer again (the in-process god flag; with Valkey, the shared one);
 *   - no other instance heard at all. The Casbin write alongside it is
 *     published, but when the user's role links end up as they were (a god
 *     holding `member@*`, demoted to `member`) a replica has nothing to apply,
 *     and when they do change it applies them before the commit.
 *
 * A demoted god kept every open stream it had, unfiltered, until the client
 * reconnected. Replicas are played in one process as in
 * `realtime-rule-cross-instance.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dispatchToWs, realtimeBus, type RealtimeBusMessage } from '../../lib/runtime/index.js';
import {
  __sweepIdle,
  getEnforcer,
  isGodUser,
  permissionGeneration,
} from '../../lib/tenancy/index.js';
import { _wsPermCacheForTests, broadcastEvent, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COL = `urxi_${STAMP}`;
const FIELDS = [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }];

d('a user role change reaches open subscriptions', () => {
  let app: Hono;
  let db: Database;
  const gods: string[] = [];
  const probes: string[] = [];
  const sent: Array<Omit<RealtimeBusMessage, 'originId'>> = [];
  const bus = realtimeBus();
  const origPublish = bus.publish;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, { name: COL, fields: FIELDS } as never);
    bus.publish = async (payload) => {
      sent.push(payload);
    };
  });

  afterAll(async () => {
    bus.publish = origPublish;
    if (!db) return;
    for (const id of probes) _wsPermCacheForTests().connections.delete(id);
    const e = await getEnforcer();
    for (const id of gods) await e.deleteRolesForUser(id, '*').catch(() => {});
    await dropTestCollection(db, COL).catch(() => {});
  });

  /** A god, holding `member@*` as well, with a socket subscribed to COL. */
  async function godWithSocket() {
    const cookie = await createGodSession(app, db);
    const { id: userId } = await db
      .selectFrom('user')
      .select('id')
      .where('role', '=', 'god')
      .executeTakeFirstOrThrow();
    gods.push(userId);
    await (await getEnforcer()).addRoleForUser(userId, 'member', '*');

    const id = `ws_urxi_${probes.length}_${STAMP}`;
    probes.push(id);
    const frames: string[] = [];
    const ws = {
      data: { id, userId, tenantId: null, authType: 'session' },
      send: (p: string) => frames.push(p),
      close: () => {},
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COL] }),
    );
    expect(frames.join('\n')).toContain('"type":"subscribed"');
    const conn = _wsPermCacheForTests().connections.get(id)!;
    return { cookie, userId, ws, frames, conn };
  }

  const demote = (cookie: string, userId: string) =>
    app.request(`/api/users/${userId}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });

  const leaks = (frames: string[], title: string) => {
    frames.length = 0;
    broadcastEvent(COL, 'insert', { id: title, title }, null);
    return frames.join('\n').includes(title);
  };

  it('the writing instance stops streaming to a god it demoted', async () => {
    const { cookie, userId, frames } = await godWithSocket();
    expect((await demote(cookie, userId)).status).toBe(200);
    for (let i = 0; i < 20; i++) await Bun.sleep(10);
    await __sweepIdle();

    expect(await isGodUser(userId)).toBe(false);
    expect(leaks(frames, `LOCAL-${STAMP}`)).toBe(false);
  });

  it('another instance stops streaming to a god demoted here', async () => {
    const { cookie, userId, ws, frames, conn } = await godWithSocket();
    const stale = { subs: new Set(conn.subscriptions), access: conn.access.get(COL)! };
    sent.length = 0;

    expect((await demote(cookie, userId)).status).toBe(200);
    for (let i = 0; i < 20; i++) await Bun.sleep(10);
    await __sweepIdle();

    // Instance B: the socket as B still holds it — subscribed, the god's
    // snapshot, and a subscribe decision filed in B's current generation.
    const { indexSubscription, wsPermCache } = _wsPermCacheForTests();
    for (const ch of stale.subs) {
      conn.subscriptions.add(ch);
      indexSubscription(ch, probes.at(-1)!);
    }
    conn.access.set(COL, stale.access);
    wsPermCache
      .get(ws)!
      .set(COL, { allowed: true, checkedAt: Date.now(), gen: permissionGeneration() });
    expect(leaks(frames, `STALE-${STAMP}`)).toBe(true); // the state B is in

    for (const m of sent.splice(0)) await dispatchToWs({ ...m, originId: 'replica-a' });
    await __sweepIdle();

    expect(leaks(frames, `REPLICA-${STAMP}`)).toBe(false);
  });
});
