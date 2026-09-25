/**
 * Row rules and column permissions reached an open realtime subscription only
 * on reconnect — and a generic admin publish could speak on a data channel.
 *
 * Both doors resolve a subscriber's row rules and column permissions once, when
 * the subscription opens, and filter every delivery through that snapshot. A
 * rule written afterwards through `/api/admin/rls` or
 * `/api/admin/column-permissions` triggered no re-check at all, and the sweep a
 * Casbin change triggers re-asked `read` alone: the WebSocket kept its snapshot
 * (`resolveSocketAccess` returns early while one is cached), the SSE stream
 * kept its own. So a member newly restricted to their own rows, or newly
 * denied a column, went on receiving every row and every column until the
 * client reconnected.
 *
 * `POST /api/realtime/publish` took any channel, `zveltio:data:<collection>`
 * included, and handed the payload to every stream subscribed to it — no row
 * rule, no column mask. Data channels belong to the write path, which filters.
 *
 * Asserts on what the fan-out hands each subscriber, not on frames read back
 * from a body — see `_sseConnectionsForTests`.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getEnforcer } from '../../lib/tenancy/index.js';
import {
  _sseConnectionsForTests,
  broadcastDataEvent,
  revalidateSseStreams,
} from '../../routes/realtime.js';
import {
  _wsPermCacheForTests,
  broadcastEvent,
  revalidateWsSubscriptions,
  websocketHandler,
} from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const WS_COL = `rtfresh_ws_${STAMP}`;
const SSE_COL = `rtfresh_sse_${STAMP}`;
const PUB_COL = `rtfresh_pub_${STAMP}`;

const FIELDS = [
  { name: 'title', type: 'text', required: false, unique: false, indexed: false },
  { name: 'salary', type: 'text', required: false, unique: false, indexed: false },
  { name: 'owner', type: 'text', required: false, unique: false, indexed: false },
];

/** The sweep runs off the change, not inside the request; wait for it. */
async function settle(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(10);
}

d('open realtime subscriptions follow row and column rule changes', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  const probes: string[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    for (const name of [WS_COL, SSE_COL, PUB_COL]) {
      await DDLManager.createCollection(db, { name, fields: FIELDS } as never);
    }
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of probes) _wsPermCacheForTests().connections.delete(id);
    for (const name of [WS_COL, SSE_COL, PUB_COL]) {
      await sql`DELETE FROM zvd_rls_policies WHERE collection = ${name}`
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_column_permissions')
        .where('collection_name', '=', name)
        .execute()
        .catch(() => {});
      await dropTestCollection(db, name).catch(() => {});
    }
  });

  function admin(path: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const ownRowsOnly = (collection: string) =>
    admin('/api/admin/rls', {
      collection,
      role: 'member',
      filter_field: 'owner',
      filter_op: 'eq',
      filter_value_source: 'user_id',
    });

  /** A member socket subscribed to `collection`, driven through the real handlers. */
  async function openSocket(collection: string) {
    const member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection, actions: ['read', 'list'] }],
    });
    const id = `ws_rtfresh_${probes.length}_${STAMP}`;
    probes.push(id);
    const sent: string[] = [];
    const ws = {
      data: { id, userId: member.userId, tenantId: null, authType: 'session' },
      send: (p: string) => sent.push(p),
      close: () => {},
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [collection] }),
    );
    expect(sent.join('\n')).toContain('"type":"subscribed"');
    sent.length = 0;
    return { member, sent };
  }

  /** A member SSE stream on `?collection=` (plus `?channel=`), with its deliveries recorded. */
  async function openStream(collection: string, channel?: string) {
    const member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection, actions: ['read', 'list'] }],
    });
    const qs = `collection=${collection}${channel ? `&channel=${channel}` : ''}`;
    const res = await app.request(`/api/realtime/stream?${qs}`, {
      headers: { cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // `connected` — the subscription is registered
    const sub = [..._sseConnectionsForTests().get(member.userId)!][0]!;
    const delivered: string[] = [];
    const realWrite = sub.stream.writeSSE.bind(sub.stream);
    sub.stream.writeSSE = (msg: { data: string; event?: string }) => {
      delivered.push(msg.data);
      return realWrite(msg);
    };
    const open = () => _sseConnectionsForTests().has(member.userId);
    return { member, reader, delivered, sub, open };
  }

  it('POST /realtime/publish refuses a data channel; the stream receives nothing', async () => {
    const { reader, delivered } = await openStream(PUB_COL, `data:${PUB_COL}`);
    const res = await admin('/api/realtime/publish', {
      channel: `zveltio:data:${PUB_COL}`,
      payload: { id: 'forged', owner: 'someone-else', salary: 'PUBLISHED-SECRET' },
    });
    expect(res.status).toBe(400);
    expect(delivered.join('\n')).not.toContain('PUBLISHED-SECRET');
    await reader.cancel().catch(() => {});
  });

  it('a WebSocket applies a row rule created after it subscribed', async () => {
    const { member, sent } = await openSocket(WS_COL);
    expect((await ownRowsOnly(WS_COL)).status).toBe(201);
    await Bun.sleep(200); // the sweep

    sent.length = 0;
    broadcastEvent(WS_COL, 'insert', { id: 'o1', title: 'OTHERS-ROW', owner: 'x' }, null);
    broadcastEvent(WS_COL, 'insert', { id: 'm1', title: 'OWN-ROW', owner: member.userId }, null);
    expect(sent.join('\n')).not.toContain('OTHERS-ROW');
    expect(sent.join('\n')).toContain('OWN-ROW');
  });

  it('a WebSocket applies a column permission created after it subscribed', async () => {
    const { member, sent } = await openSocket(WS_COL);
    const res = await admin('/api/admin/column-permissions', {
      collection_name: WS_COL,
      column_name: 'salary',
      role: 'member',
      can_read: false,
      can_write: false,
    });
    expect(res.status).toBe(201);
    await Bun.sleep(200);

    sent.length = 0;
    broadcastEvent(
      WS_COL,
      'insert',
      { id: 'm2', title: 'visible', salary: 'COLUMN-SECRET', owner: member.userId },
      null,
    );
    expect(sent.join('\n')).toContain('visible');
    expect(sent.join('\n')).not.toContain('COLUMN-SECRET');
  });

  it('a WebSocket whose access lookup throws keeps its rules and reports the failure', async () => {
    const { member, sent } = await openSocket(WS_COL); // row rule + column mask in force
    const spy = spyOn(await getEnforcer(), 'getRolesForUser').mockRejectedValue(
      new Error('role manager unavailable'),
    );
    try {
      expect(await revalidateWsSubscriptions()).toBe(true);
    } finally {
      spy.mockRestore();
    }
    sent.length = 0;
    broadcastEvent(WS_COL, 'insert', { id: 'o3', title: 'OTHERS-AFTER', owner: 'x' }, null);
    broadcastEvent(
      WS_COL,
      'insert',
      { id: 'm3', title: 'OWN-AFTER', salary: 'COLUMN-SECRET', owner: member.userId },
      null,
    );
    const got = sent.join('\n');
    expect(got).toContain('OWN-AFTER'); // still subscribed
    expect(got).not.toContain('OTHERS-AFTER'); // the rule it had still applies
    expect(got).not.toContain('COLUMN-SECRET');
  });

  it('an SSE stream ends when a row rule changes what it may receive', async () => {
    const { reader, delivered, sub, open } = await openStream(SSE_COL);
    broadcastDataEvent(SSE_COL, 'insert', { id: 'b', title: 'BEFORE', owner: 'x' }, sub.tenantId);
    expect(delivered.join('')).toContain('BEFORE');

    expect((await ownRowsOnly(SSE_COL)).status).toBe(201);
    await settle(() => !open());
    expect(open()).toBe(false);

    delivered.length = 0;
    broadcastDataEvent(SSE_COL, 'insert', { id: 'a', title: 'AFTER', owner: 'x' }, sub.tenantId);
    expect(delivered.join('')).not.toContain('AFTER');
    await reader.cancel().catch(() => {});
  });

  it('an SSE stream whose access did not change stays open through a sweep', async () => {
    const { reader, open } = await openStream(SSE_COL); // opened under the rule
    // A change elsewhere sweeps every stream; this one's rules are unchanged.
    const res = await admin('/api/admin/column-permissions', {
      collection_name: PUB_COL,
      column_name: 'salary',
      role: 'member',
      can_read: false,
      can_write: false,
    });
    expect(res.status).toBe(201);
    await Bun.sleep(200);
    expect(open()).toBe(true);
    await reader.cancel().catch(() => {});
  });

  it('an SSE stream whose access lookup throws stays open and reports the failure', async () => {
    const { reader, open } = await openStream(SSE_COL);
    const spy = spyOn(await getEnforcer(), 'getRolesForUser').mockRejectedValue(
      new Error('role manager unavailable'),
    );
    try {
      expect(await revalidateSseStreams()).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(open()).toBe(true);
    await reader.cancel().catch(() => {});
  });
});
