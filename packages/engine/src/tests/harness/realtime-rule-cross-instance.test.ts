/**
 * A row rule or column permission written on one engine instance must reach
 * the open realtime subscriptions of every other instance.
 *
 * A rule write swept the open WebSockets and SSE streams of the instance that
 * ran it (`revalidateSockets`) and published nothing. The rules themselves live
 * in the database and the shared cache, which the writer purges — but each open
 * subscription filters with the snapshot it resolved, and a replica only
 * re-resolves on a sweep. So a member restricted to their own rows, or denied a
 * column, kept receiving every row and every column from any replica other than
 * the one the admin happened to hit, until the client reconnected.
 *
 * Each test plays both replicas in one process, like
 * `casbin-cross-instance-policy.test.ts`: the real admin write runs here
 * (instance A) with the bus publish captured, the subscription is put back to
 * the snapshot a replica that never swept would still hold (instance B), and
 * the captured messages are delivered through `dispatchToWs` exactly as the
 * Valkey / pg_notify subscriber does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dispatchToWs, realtimeBus, type RealtimeBusMessage } from '../../lib/runtime/index.js';
import { __sweepIdle } from '../../lib/tenancy/index.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { _wsPermCacheForTests, broadcastEvent, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const ROW_COL = `rtxi_row_${STAMP}`;
const MASK_COL = `rtxi_mask_${STAMP}`;
const SSE_COL = `rtxi_sse_${STAMP}`;
const FIELDS = [
  { name: 'title', type: 'text', required: false, unique: false, indexed: false },
  { name: 'salary', type: 'text', required: false, unique: false, indexed: false },
  { name: 'owner', type: 'text', required: false, unique: false, indexed: false },
];

/** The writer's sweep runs after the commit, not inside the request. */
async function settle(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(10);
  await __sweepIdle();
}

d('row and column rule changes reach other instances', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  const probes: string[] = [];
  const sent: Array<Omit<RealtimeBusMessage, 'originId'>> = [];
  const bus = realtimeBus();
  const origPublish = bus.publish;

  /** Instance B receives what instance A published, then finishes its sweep. */
  async function deliverToReplica(): Promise<void> {
    for (const m of sent.splice(0)) await dispatchToWs({ ...m, originId: 'replica-a' });
    await __sweepIdle();
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    for (const name of [ROW_COL, MASK_COL, SSE_COL]) {
      await DDLManager.createCollection(db, { name, fields: FIELDS } as never);
    }
    bus.publish = async (payload) => {
      sent.push(payload);
    };
  });

  afterAll(async () => {
    bus.publish = origPublish;
    if (!db) return;
    for (const id of probes) _wsPermCacheForTests().connections.delete(id);
    for (const name of [ROW_COL, MASK_COL, SSE_COL]) {
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

  const hideSalary = (collection_name: string) =>
    admin('/api/admin/column-permissions', {
      collection_name,
      column_name: 'salary',
      role: 'member',
      can_read: false,
      can_write: false,
    });

  async function openSocket(collection: string) {
    const member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection, actions: ['read', 'list'] }],
    });
    const id = `ws_rtxi_${probes.length}_${STAMP}`;
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
    const conn = _wsPermCacheForTests().connections.get(id)!;
    return { member, sent, conn };
  }

  async function openStream(collection: string) {
    const member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection, actions: ['read', 'list'] }],
    });
    const res = await app.request(`/api/realtime/stream?collection=${collection}`, {
      headers: { cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // `connected` — the subscription is registered
    const sub = [..._sseConnectionsForTests().get(member.userId)!][0]!;
    const open = () => _sseConnectionsForTests().has(member.userId);
    return { reader, sub, open };
  }

  it('a WebSocket on another instance applies a row rule written here', async () => {
    const { member, sent: frames, conn } = await openSocket(ROW_COL);
    const stale = conn.access.get(ROW_COL);
    sent.length = 0;

    // Instance A: the admin write, and A's own sweep.
    const res = await admin('/api/admin/rls', {
      collection: ROW_COL,
      role: 'member',
      filter_field: 'owner',
      filter_op: 'eq',
      filter_value_source: 'user_id',
    });
    expect(res.status).toBe(201);
    await settle(() => conn.access.get(ROW_COL) !== stale);

    // Instance B never swept: its socket still holds the snapshot from subscribe.
    conn.access.set(ROW_COL, stale!);
    await deliverToReplica();

    frames.length = 0;
    broadcastEvent(ROW_COL, 'insert', { id: 'o1', title: 'OTHERS-ROW', owner: 'x' }, null);
    broadcastEvent(ROW_COL, 'insert', { id: 'm1', title: 'OWN-ROW', owner: member.userId }, null);
    expect(frames.join('\n')).toContain('OWN-ROW');
    expect(frames.join('\n')).not.toContain('OTHERS-ROW');
  });

  it('a WebSocket on another instance applies a column permission written here', async () => {
    const { member, sent: frames, conn } = await openSocket(MASK_COL);
    const stale = conn.access.get(MASK_COL);
    sent.length = 0;

    expect((await hideSalary(MASK_COL)).status).toBe(201);
    await settle(() => conn.access.get(MASK_COL) !== stale);

    conn.access.set(MASK_COL, stale!);
    await deliverToReplica();

    frames.length = 0;
    broadcastEvent(
      MASK_COL,
      'insert',
      { id: 'm2', title: 'visible', salary: 'COLUMN-SECRET', owner: member.userId },
      null,
    );
    expect(frames.join('\n')).toContain('visible');
    expect(frames.join('\n')).not.toContain('COLUMN-SECRET');
  });

  it('an SSE stream on another instance ends when a rule written here changes it', async () => {
    // The snapshot a stream opened before the change holds.
    const before = await openStream(SSE_COL);
    const stale = before.sub.access;
    sent.length = 0;

    expect((await hideSalary(SSE_COL)).status).toBe(201);
    await settle(() => !before.open()); // A's own stream ends on A's sweep
    await before.reader.cancel().catch(() => {});

    // Instance B's stream, which never swept: still filtering with the old rules.
    const after = await openStream(SSE_COL);
    after.sub.access = stale;
    await deliverToReplica();
    expect(after.open()).toBe(false);
    await after.reader.cancel().catch(() => {});
  });
});
