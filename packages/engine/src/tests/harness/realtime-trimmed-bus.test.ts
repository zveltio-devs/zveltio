/**
 * ADR 0036 decision 4: a cross-instance record event too large for pg_notify
 * keeps `id` and the columns the collection's row rules read; the receiving
 * instance gates on that and delivers the event without `data`.
 *
 * It used to drop all of `data`, and the receiver substituted `{ id }`: a
 * subscriber under a row rule was decided on a record without the rule's column
 * and heard nothing; one with no rule received `data: { id }`. Whether a client
 * saw an event depended on the record's size and on which instance it was on.
 *
 * Both instances in one process. Instance A is the real write through
 * `POST /api/data`, its bus message captured and run through the real
 * `PgNotifyRealtimeBus.publish` (the trim, the rule-column lookup, the byte cap);
 * instance B receives the encoded payload through `dispatchToWs`, as the LISTEN
 * handler does. A's own local fan-out reaches the same sockets first and is
 * discarded before B's delivery is read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  dispatchToWs,
  PG_NOTIFY_PAYLOAD_MAX,
  PgNotifyRealtimeBus,
  realtimeBus,
  type RealtimeBusMessage,
} from '../../lib/runtime/realtime-bus.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import * as wsModule from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COL = `rttrim_${STAMP}`;
const E_COL = `rttrim_e_${STAMP}`;
const OWNER = `rttrim_${STAMP}`;
const BIG = 'x'.repeat(9_000);

const FIELDS = [
  { name: 'title', type: 'text', required: false, unique: false, indexed: false },
  { name: 'owner', type: 'text', required: false, unique: false, indexed: false },
  { name: 'body', type: 'text', required: false, unique: false, indexed: false },
];

/** A record event as a client received it: the whole frame, so `data`'s absence shows. */
type Frame = { id?: string; data?: Record<string, unknown> };

d('ADR 0036 decision 4: a trimmed bus message is gated on what it keeps', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  const closers: Array<() => Promise<void> | void> = [];
  const captured: Array<Omit<RealtimeBusMessage, 'originId'>> = [];
  const bus = realtimeBus();
  const origPublish = bus.publish;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    // The writer holds no `member`: since ADR 0037 a member rule binds a god's writes too.
    const session = await app.request('/api/auth/get-session', { headers: { cookie: god } });
    const godId = ((await session.json()) as { user: { id: string } }).user.id;
    await (await getEnforcer()).deleteRoleForUser(godId, 'member', '*');
    await invalidateUserPermCache(godId);
    for (const name of [COL, E_COL]) {
      await DDLManager.createCollection(db, { name, fields: FIELDS } as never);
      const res = await app.request('/api/admin/rls', {
        method: 'POST',
        headers: { cookie: god, 'content-type': 'application/json' },
        body: JSON.stringify({
          collection: name,
          role: 'member',
          filter_field: 'owner',
          filter_op: 'eq',
          filter_value_source: 'user_id',
        }),
      });
      expect(res.status).toBe(201);
    }
    bus.publish = async (payload) => {
      captured.push(payload);
    };
  });

  afterAll(async () => {
    bus.publish = origPublish;
    entityAccessRegistry.unregisterAll(OWNER);
    for (const close of closers) await close();
    if (!db) return;
    for (const name of [COL, E_COL]) {
      await sql`DELETE FROM zvd_rls_policies WHERE collection = ${name}`
        .execute(db)
        .catch(() => {});
      await dropTestCollection(db, name).catch(() => {});
    }
  });

  async function member(collection: string) {
    return createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection, actions: ['read', 'list'] }],
    });
  }

  async function socket(collection: string, cookie: string): Promise<Frame[]> {
    const frames: Frame[] = [];
    const ws = {
      data: { ...(await wsUpgradeData(app, { cookie })), id: `ws_rttrim_${crypto.randomUUID()}` },
      send: (p: string) => {
        const m = JSON.parse(p) as Frame & { type?: string };
        if (m.type === 'event') frames.push(m);
      },
      close: () => {},
    };
    wsModule.websocketHandler.open(ws as never);
    await wsModule.websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [collection] }),
    );
    closers.push(() => wsModule.websocketHandler.close(ws as never));
    return frames;
  }

  async function stream(
    collection: string,
    who: { cookie: string; userId: string },
    filter?: object,
  ) {
    const frames: Frame[] = [];
    const q = filter ? `&filter=${encodeURIComponent(JSON.stringify(filter))}` : '';
    const res = await app.request(`/api/realtime/stream?collection=${collection}${q}`, {
      headers: { cookie: who.cookie },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // `connected`: the stream is registered
    const sub = [..._sseConnectionsForTests().get(who.userId)!].at(-1)!;
    const realWrite = sub.stream.writeSSE.bind(sub.stream);
    sub.stream.writeSSE = (msg: { data: string; event?: string }) => {
      if (msg.event === 'data') frames.push(JSON.parse(msg.data) as Frame);
      return realWrite(msg);
    };
    closers.push(() => reader.cancel().catch(() => {}));
    return frames;
  }

  /** Instance A writes; returns the id. A's own fan-out is left out of `frames`. */
  async function writeOnA(collection: string, owner: string, frames: Frame[][]): Promise<string> {
    captured.length = 0;
    const res = await app.request(`/api/data/${collection}`, {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'big', owner, body: BIG }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    for (let i = 0; i < 100 && captured.length === 0; i++) await Bun.sleep(10);
    await Bun.sleep(50); // the local fan-out runs after the commit, beside the publish
    for (const f of frames) f.length = 0;
    return id;
  }

  /** What A's pg_notify bus puts on the wire, received by instance B. */
  async function deliverToB(): Promise<RealtimeBusMessage> {
    const wire: string[] = [];
    const a = new PgNotifyRealtimeBus('postgres://unused');
    a.setPublisher({ notify: async (_ch, payload) => wire.push(payload) });
    expect(captured.length).toBe(1);
    await a.publish(captured[0]!);
    expect(wire.length).toBe(1);
    expect(Buffer.byteLength(wire[0]!, 'utf8')).toBeLessThanOrEqual(PG_NOTIFY_PAYLOAD_MAX);
    const msg = { ...(JSON.parse(wire[0]!) as RealtimeBusMessage), originId: 'replica-a' };
    await dispatchToWs(msg);
    await Bun.sleep(50);
    return msg;
  }

  it('B delivers `id` without data to whoever the rule admits, and nothing to whom it excludes', async () => {
    const admitted = await member(COL);
    const excluded = await member(COL);
    const wsAdmitted = await socket(COL, admitted.cookie);
    const wsExcluded = await socket(COL, excluded.cookie);
    const wsNoRule = await socket(COL, god); // a god: no row rule binds
    const sseAdmitted = await stream(COL, admitted);
    const sseFiltered = await stream(COL, admitted, { title: { neq: 'other' } }); // a column the trim dropped
    const all = [wsAdmitted, wsExcluded, wsNoRule, sseAdmitted, sseFiltered];

    const id = await writeOnA(COL, admitted.userId, all);
    const msg = await deliverToB();

    for (const got of [wsAdmitted, wsNoRule, sseAdmitted]) {
      expect(got.length).toBe(1);
      expect(got[0]!.id).toBe(id);
      expect('data' in got[0]!).toBe(false); // not `data: { id }`
    }
    expect(wsExcluded).toEqual([]);
    // `title` was trimmed away: the filter cannot be decided, so nothing.
    expect(sseFiltered).toEqual([]);
    expect(msg.trimmed).toBe(true);
    expect(msg.data).toEqual({ id, owner: admitted.userId }); // id + the rule's column

    // GET agrees: the admitted member may read it, the excluded one may not.
    const get = (cookie: string) => app.request(`/api/data/${COL}/${id}`, { headers: { cookie } });
    expect((await get(admitted.cookie)).status).toBe(200);
    expect((await get(excluded.cookie)).status).toBe(404);
  });

  it('an entity-access check cannot be decided on a trimmed record, so B delivers nothing', async () => {
    const who = await member(E_COL);
    // Allows everything: on the full record the event would be delivered.
    entityAccessRegistry.registerAs(OWNER, DDLManager.getTableName(E_COL), () => 'allow');
    try {
      const ws = await socket(E_COL, who.cookie);
      const sse = await stream(E_COL, who);
      await writeOnA(E_COL, who.userId, [ws, sse]);
      await deliverToB();
      expect(ws).toEqual([]);
      expect(sse).toEqual([]);
    } finally {
      entityAccessRegistry.unregisterAll(OWNER);
    }
  });
});
