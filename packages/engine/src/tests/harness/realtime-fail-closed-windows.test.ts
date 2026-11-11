/**
 * LV-11 (ADR 0036 decision 2): what a realtime door delivers is at most what
 * `GET /api/data/:collection/:id` serves the subscriber at that moment; when the
 * engine cannot know that, it delivers nothing.
 *
 * Two windows used to break it. A rule change is swept asynchronously, and until
 * the sweep re-resolved a subscription it delivered by the rules it resolved
 * before — `GET` had no such window, Postgres applies the change with its
 * commit. And while an instance's bus connection was down it could not hear a
 * rule change made elsewhere, yet its local writes still fanned out. Now a scope
 * carries the generation it was resolved at and is silent once a change moves
 * it, and nothing is delivered while the bus is down. The Electric long poll,
 * the third record door, follows the same rule.
 *
 * Real writes through `POST /api/data`, delivered by the write path; the answer
 * compared against `GET` as the subscriber, step by step, on both doors.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Hono } from 'hono';
import type pg from 'pg';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { busDeaf, realtimeBus, ValkeyRealtimeBus } from '../../lib/runtime/realtime-bus.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import {
  __resetSweepRetry,
  __sweepIdle,
  accessGeneration,
  revalidateSockets,
  sweepGeneration,
} from '../../lib/tenancy/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import * as electric from '../../routes/electric.js';
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
const WS_COL = `lv11_ws_${STAMP}`;
const SSE_COL = `lv11_sse_${STAMP}`;
const BUS_COL = `lv11_bus_${STAMP}`;
const Q_COL = `lv11_queue_${STAMP}`;
const X_COL = `lv11_x_${STAMP}`;
const Y_COL = `lv11_y_${STAMP}`;
const E_COL = `lv11_retry_${STAMP}`;
const K_COL = `lv11_key_${STAMP}`;
const SHAPE_COL = `lv11_shape_${STAMP}`;
const COLS = [WS_COL, SSE_COL, BUS_COL, Q_COL, X_COL, Y_COL, E_COL, K_COL, SHAPE_COL];
const OWNER = `lv11_${STAMP}`;

const FIELDS = [
  { name: 'title', type: 'text', required: false, unique: false, indexed: false },
  { name: 'salary', type: 'text', required: false, unique: false, indexed: false },
  { name: 'owner', type: 'text', required: false, unique: false, indexed: false },
];

type Row = Record<string, unknown> & { id: string };
type Member = { cookie: string; userId: string };

/** One door's subscription, read as the events it delivered. */
interface Door {
  events: Row[];
  /** After a sweep: the SSE stream ends when its rules moved, and its client reconnects. */
  reconnect(): Promise<void>;
  close(): Promise<void>;
  /** WebSocket only: one more client frame. */
  frame?(msg: unknown): Promise<void>;
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  for (let t = 0; t < ms && !cond(); t += 20) await Bun.sleep(20);
}

/**
 * Holds every sweep at its first await — the window an instance has between a
 * change and the sweep's end — until released. `reached()` says one got there.
 */
function holdSweep() {
  let open!: () => void;
  const held = new Promise<void>((r) => {
    open = r;
  });
  let reached = false;
  const spy = spyOn(electric, 'interruptLivePolls').mockImplementation((() => {
    reached = true;
    return held;
  }) as unknown as typeof electric.interruptLivePolls);
  return {
    reached: () => reached,
    release: () => {
      open();
      spy.mockRestore();
    },
  };
}

/** A stand-in Electric service: answers a shape when `answer()` is called. */
function fakeElectric() {
  let arrived = false;
  let answer: () => void = () => {};
  let streaming = false;
  const enc = new TextEncoder();
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      arrived = true;
      const gate = new Promise<void>((r) => {
        answer = r;
      });
      const headers = { 'content-type': 'application/json', 'electric-offset': '0_0' };
      if (streaming) {
        // Headers and the first byte now, the row only once released.
        return new Response(
          new ReadableStream({
            async start(ctl) {
              ctl.enqueue(enc.encode('['));
              await gate;
              ctl.enqueue(enc.encode('{"value":{"title":"LEAK"}}]'));
              ctl.close();
            },
          }),
          { headers },
        );
      }
      await gate;
      return new Response('[{"value":{"title":"LEAK"}}]', { headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    arrived: () => arrived,
    answer: () => answer(),
    reset: (stream: boolean) => {
      arrived = false;
      streaming = stream;
    },
    stop: () => server.stop(true),
  };
}

d('LV-11: realtime delivers at most what GET serves, and nothing in the windows', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  const opened: Door[] = [];
  const upstream = fakeElectric();
  const savedEnv = { url: process.env.ELECTRIC_URL, secret: process.env.ELECTRIC_SECRET };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    // The writer of every row here holds no `member`: the rules below are
    // members', and since ADR 0037 a rule binds a god's writes too.
    const session = await app.request('/api/auth/get-session', { headers: { cookie: god } });
    const godId = ((await session.json()) as { user: { id: string } }).user.id;
    await (await getEnforcer()).deleteRoleForUser(godId, 'member', '*');
    await invalidateUserPermCache(godId);
    for (const name of COLS) {
      await DDLManager.createCollection(db, { name, fields: FIELDS } as never);
    }
    process.env.ELECTRIC_URL = upstream.url;
    process.env.ELECTRIC_SECRET = 'lv11-secret';
  });

  afterAll(async () => {
    upstream.stop();
    for (const [k, v] of [
      ['ELECTRIC_URL', savedEnv.url],
      ['ELECTRIC_SECRET', savedEnv.secret],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    entityAccessRegistry.unregisterAll(OWNER);
    if (!db) return;
    for (const door of opened) await door.close();
    for (const name of COLS) {
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

  async function admin(method: string, path: string, body: unknown) {
    const res = await app.request(path, {
      method,
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBeLessThan(300);
    return (await res.json()) as { policy?: { id: string }; id?: string; key?: string };
  }

  /** Members see their own rows only, and never `salary`. Returns the row rule's id. */
  async function restrict(collection: string): Promise<string> {
    await admin('POST', '/api/admin/column-permissions', {
      collection_name: collection,
      column_name: 'salary',
      role: 'member',
      can_read: false,
      can_write: false,
    });
    const { policy } = await admin('POST', '/api/admin/rls', {
      collection,
      role: 'member',
      filter_field: 'owner',
      filter_op: 'eq',
      filter_value_source: 'user_id',
    });
    return policy!.id;
  }

  async function write(collection: string, body: Record<string, string>): Promise<string> {
    const res = await app.request(`/api/data/${collection}`, {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as Row).id;
  }

  /** `GET /api/data/:collection/:id` as the subscriber: the record, or null. */
  async function served(collection: string, who: Member, id: string): Promise<Row | null> {
    const res = await app.request(`/api/data/${collection}/${id}`, {
      headers: { cookie: who.cookie },
    });
    if (res.status === 404) return null;
    expect(res.status).toBe(200);
    return (await res.json()) as Row;
  }

  /**
   * The step's verdict: the events delivered for `ids` are exactly the rows GET
   * serves of them, each with the columns GET serves.
   */
  async function expectEqualsGet(collection: string, who: Member, door: Door, ids: string[]) {
    await Bun.sleep(100); // delivery runs after the write's commit
    const got = new Map(door.events.filter((e) => ids.includes(e.id)).map((e) => [e.id, e]));
    const want = new Map<string, Row>();
    for (const id of ids) {
      const row = await served(collection, who, id);
      if (row) want.set(id, row);
    }
    expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
    for (const [id, row] of want) {
      expect(Object.keys(got.get(id)!).sort()).toEqual(Object.keys(row).sort());
    }
    expect(want.size).toBeGreaterThan(0); // the step is not vacuous
  }

  const delivered = (door: Door, id: string) => door.events.some((e) => e.id === id);

  async function member(...collections: string[]): Promise<Member> {
    return createMemberSession(app, db, {
      role: 'member',
      grants: collections.map((collection) => ({ collection, actions: ['read', 'list'] })),
    });
  }

  async function wsDoor(collection: string, headers: Record<string, string>): Promise<Door> {
    const events: Row[] = [];
    const ws = {
      data: { ...(await wsUpgradeData(app, headers)), id: `ws_lv11_${crypto.randomUUID()}` },
      send: (p: string) => {
        const m = JSON.parse(p) as { type?: string; data?: Row };
        if (m.type === 'event' && m.data) events.push(m.data);
      },
      close: () => {},
    };
    const frame = (msg: unknown) =>
      wsModule.websocketHandler.message(ws as never, JSON.stringify(msg));
    wsModule.websocketHandler.open(ws as never);
    await frame({ type: 'subscribe', collections: [collection] });
    const door: Door = {
      events,
      reconnect: async () => {},
      close: async () => wsModule.websocketHandler.close(ws as never),
      frame,
    };
    opened.push(door);
    return door;
  }

  async function sseDoor(collection: string, who: Member): Promise<Door> {
    const events: Row[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const open = async () => {
      const res = await app.request(`/api/realtime/stream?collection=${collection}`, {
        headers: { cookie: who.cookie },
      });
      expect(res.status).toBe(200);
      reader = res.body!.getReader();
      await reader.read(); // `connected`: the stream is registered
      const sub = [..._sseConnectionsForTests().get(who.userId)!].at(-1)!;
      const realWrite = sub.stream.writeSSE.bind(sub.stream);
      sub.stream.writeSSE = (msg: { data: string; event?: string }) => {
        if (msg.event === 'data') events.push((JSON.parse(msg.data) as { data: Row }).data);
        return realWrite(msg);
      };
    };
    await open();
    const door: Door = {
      events,
      reconnect: async () => {
        if (!_sseConnectionsForTests().has(who.userId)) await open();
      },
      close: async () => {
        await reader?.cancel().catch(() => {});
      },
    };
    opened.push(door);
    return door;
  }

  const doorsFor = async (collection: string, who: Member) => [
    await wsDoor(collection, { cookie: who.cookie }),
    await sseDoor(collection, who),
  ];

  for (const [name, collection, openDoor] of [
    ['WebSocket', WS_COL, (c: string, w: Member) => wsDoor(c, { cookie: w.cookie })],
    ['SSE', SSE_COL, sseDoor],
  ] as const) {
    it(`${name}: events equal GET under a row rule and a column permission, through a rule change`, async () => {
      const ruleId = await restrict(collection);
      const who = await member(collection);
      const door = await openDoor(collection, who);

      // Step 1: writes on both sides of the rule.
      await expectEqualsGet(collection, who, door, [
        await write(collection, { title: 'mine', salary: 'S1', owner: who.userId }),
        await write(collection, { title: 'theirs', salary: 'S2', owner: 'someone-else' }),
      ]);

      // Step 2: the rule changes while subscribed, and the sweep is held.
      await __sweepIdle();
      const sweep = holdSweep();
      try {
        await admin('PATCH', `/api/admin/rls/${ruleId}`, {
          filter_field: 'title',
          filter_op: 'eq',
          filter_value_source: 'static:shared',
        });
        await until(sweep.reached);
        expect(sweep.reached()).toBe(true);
        const before = door.events.length;
        const hidden = await write(collection, { title: 'mine-now-hidden', owner: who.userId });
        const shown = await write(collection, { title: 'shared', salary: 'S3', owner: 'x' });
        await Bun.sleep(100);
        // GET already answers by the new rule: the old one's row is gone.
        expect(await served(collection, who, hidden)).toBeNull();
        expect(await served(collection, who, shown)).not.toBeNull();
        // Nothing the new rule hides was delivered; in fact nothing at all —
        // the scope is stale until the sweep re-resolves it.
        expect(delivered(door, hidden)).toBe(false);
        expect(door.events.length).toBe(before);
      } finally {
        sweep.release();
      }
      await __sweepIdle();
      await door.reconnect();

      // Step 3: after the sweep, both sides of the new rule.
      await expectEqualsGet(collection, who, door, [
        await write(collection, { title: 'mine-not-shared', salary: 'S4', owner: who.userId }),
        await write(collection, { title: 'shared', salary: 'S5', owner: 'someone-else' }),
      ]);
    });
  }

  it('an event queued behind an async verdict is dropped when a change lands before it is sent', async () => {
    const who = await member(Q_COL);
    let allow: () => void = () => {};
    const verdict = new Promise<'allow'>((r) => {
      allow = () => r('allow');
    });
    // The subscriber's verdict waits; everyone else's (the writer's) does not.
    entityAccessRegistry.registerAs(OWNER, DDLManager.getTableName(Q_COL), (_r, u) =>
      (u as { id?: string }).id === who.userId ? verdict : 'allow',
    );
    try {
      const doors = await doorsFor(Q_COL, who);
      await __sweepIdle();
      const sweep = holdSweep();
      try {
        const id = await write(Q_COL, { title: 'queued', owner: who.userId });
        revalidateSockets(); // a change while the verdict is pending
        await until(sweep.reached);
        expect(sweep.reached()).toBe(true);
        allow();
        await Bun.sleep(100);
        for (const door of doors) expect(delivered(door, id)).toBe(false);
      } finally {
        sweep.release();
      }
      await __sweepIdle();
    } finally {
      entityAccessRegistry.unregisterAll(OWNER);
    }
  });

  it('a subscribe that straddles a sweep asks for one more, and moves no generation', async () => {
    const who = await member(X_COL, Y_COL);
    const door = await wsDoor(X_COL, { cookie: who.cookie });
    await __sweepIdle();
    const access = accessGeneration();
    const sweeps = sweepGeneration();
    const subscribing = door.frame!({ type: 'subscribe', collections: [Y_COL] });
    revalidateSockets('principals'); // between the subscribe's check and its registration
    await subscribing;
    await __sweepIdle();
    expect(sweepGeneration()).toBe(sweeps + 2); // that sweep, and the one the subscribe asked for
    expect(accessGeneration()).toBe(access);
    const id = await write(Y_COL, { title: 'y' });
    await Bun.sleep(100);
    expect(delivered(door, id)).toBe(true);
  });

  it('a scope left by an unsubscribe does not make every later subscribe bump the generation', async () => {
    const who = await member(X_COL, Y_COL);
    const door = await wsDoor(X_COL, { cookie: who.cookie });
    await door.frame!({ type: 'unsubscribe', collections: [X_COL] });
    revalidateSockets(); // a change: a scope kept for X would now be stale for good
    await __sweepIdle();
    const access = accessGeneration();
    await door.frame!({ type: 'subscribe', collections: [Y_COL] });
    await __sweepIdle();
    expect(accessGeneration()).toBe(access);
  });

  it('a sweep door that throws is retried, and the stale scope delivers again after the retry', async () => {
    const who = await member(E_COL);
    const door = await wsDoor(E_COL, { cookie: who.cookie });
    await __sweepIdle();
    __resetSweepRetry();
    const spy = spyOn(wsModule, 'revalidateWsSubscriptions').mockRejectedValueOnce(
      new Error('door down'),
    );
    try {
      revalidateSockets();
      await __sweepIdle();
    } finally {
      spy.mockRestore();
    }
    const during = await write(E_COL, { title: 'during' });
    await Bun.sleep(100);
    expect(delivered(door, during)).toBe(false); // stale: nothing re-resolved it
    await Bun.sleep(5_500); // the first retry
    await __sweepIdle();
    const after = await write(E_COL, { title: 'after' });
    await Bun.sleep(100);
    expect(delivered(door, after)).toBe(true);
  }, 15_000);

  it("a key's scope change delivers nothing by the old scopes while the sweep runs", async () => {
    const key = await admin('POST', '/api/api-keys', {
      name: `lv11 key ${STAMP}`,
      scopes: [{ collection: K_COL, actions: ['read'] }],
    });
    const door = await wsDoor(K_COL, { 'X-API-Key': key.key! });
    const control = await write(K_COL, { title: 'control' });
    await Bun.sleep(100);
    expect(delivered(door, control)).toBe(true);

    await __sweepIdle();
    const sweep = holdSweep();
    try {
      await admin('PATCH', `/api/admin/api-keys/${key.id}`, {
        scopes: [{ collection: Y_COL, actions: ['read'] }],
      });
      await until(sweep.reached);
      expect(sweep.reached()).toBe(true);
      const id = await write(K_COL, { title: 'after-revoke' });
      await Bun.sleep(100);
      expect(delivered(door, id)).toBe(false);
    } finally {
      sweep.release();
    }
    await __sweepIdle();
  });

  async function poll(): Promise<Response> {
    return app.request(`/api/electric/v1/shape?collection=${SHAPE_COL}&offset=-1`, {
      headers: { cookie: god },
    });
  }

  for (const stream of [false, true]) {
    it(`Electric: ${stream ? 'a row streamed' : 'an answer arriving'} after a rule change is not delivered`, async () => {
      upstream.reset(stream);
      await __sweepIdle();
      // Before the change: a stream's headers are out, an answer's are not.
      const pending = stream ? undefined : poll();
      const early = stream ? await poll() : undefined;
      await until(upstream.arrived);
      expect(upstream.arrived()).toBe(true);
      const sweep = holdSweep();
      let body = '';
      try {
        revalidateSockets();
        await until(sweep.reached);
        expect(sweep.reached()).toBe(true);
        upstream.answer();
        const res = early ?? (await pending!);
        body = await res.text().catch(() => '');
      } finally {
        sweep.release();
      }
      await __sweepIdle();
      expect(body).not.toContain('LEAK');
      // An answer that had not started is replaced whole, so the client polls
      // again cleanly; a stream already under way can only be cut.
      if (!stream) expect(body).toContain('up-to-date');
    });
  }

  it('a configured Valkey bus that cannot start leaves the instance deaf', async () => {
    const bus = new ValkeyRealtimeBus('redis://127.0.0.1:1'); // nothing listens there
    try {
      await expect(bus.start()).rejects.toThrow();
      expect(bus.isRunning).toBe(false);
      expect(busDeaf()).toBe(true);
    } finally {
      await bus.stop();
    }
    expect(busDeaf()).toBe(false);
  });

  it('while the bus is down a local write delivers nothing; after reconnect the next one does', async () => {
    await restrict(BUS_COL);
    const who = await member(BUS_COL);
    const doors = await doorsFor(BUS_COL, who);
    // The engine's own bus — pg_notify here — started as boot starts it.
    const bus = realtimeBus();
    await bus.start();
    try {
      // Positive control: with the bus up, a write is delivered on both doors.
      for (const door of doors) {
        await expectEqualsGet(BUS_COL, who, door, [
          await write(BUS_COL, { title: 'before', owner: who.userId }),
        ]);
      }

      // The bus's LISTEN connection is cut, as a network partition would.
      const listen = (bus as unknown as { client: pg.Client & { processID: number } }).client;
      await sql`SELECT pg_terminate_backend(${listen.processID})`.execute(db);
      await until(() => busDeaf());
      expect(busDeaf()).toBe(true);

      const silent = await write(BUS_COL, { title: 'during', owner: who.userId });
      await Bun.sleep(100);
      expect(await served(BUS_COL, who, silent)).not.toBeNull(); // GET serves it
      for (const door of doors) expect(delivered(door, silent)).toBe(false);
      // Nor does an Electric poll serve rows while deaf.
      expect((await poll()).status).toBe(503);

      // The reconnect (first retry after 1 s) ends the pause with a sweep.
      await until(() => bus.isRunning && !busDeaf(), 10_000);
      expect(busDeaf()).toBe(false);
      await __sweepIdle();
      for (const door of doors) {
        await door.reconnect();
        await expectEqualsGet(BUS_COL, who, door, [
          await write(BUS_COL, { title: 'after', salary: 'S6', owner: who.userId }),
        ]);
      }
    } finally {
      await bus.stop();
    }
  }, 20_000);
});
