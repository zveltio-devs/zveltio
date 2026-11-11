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
 * it, and nothing is delivered while the bus is down.
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
import { busDeaf, PgNotifyRealtimeBus } from '../../lib/runtime/realtime-bus.js';
import { __sweepIdle } from '../../lib/tenancy/index.js';
import * as electric from '../../routes/electric.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { websocketHandler } from '../../routes/ws.js';
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
const COLS = [WS_COL, SSE_COL, BUS_COL];

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
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  for (let t = 0; t < ms && !cond(); t += 20) await Bun.sleep(20);
}

d('LV-11: realtime delivers at most what GET serves, and nothing in the windows', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  const opened: Door[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    for (const name of COLS) {
      await DDLManager.createCollection(db, { name, fields: FIELDS } as never);
    }
  });

  afterAll(async () => {
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
    return (await res.json()) as { policy?: { id: string } };
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

  async function member(collection: string): Promise<Member> {
    return createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection, actions: ['read', 'list'] }],
    });
  }

  async function wsDoor(collection: string, who: Member): Promise<Door> {
    const events: Row[] = [];
    const ws = {
      data: {
        ...(await wsUpgradeData(app, { cookie: who.cookie })),
        id: `ws_lv11_${crypto.randomUUID()}`,
      },
      send: (p: string) => {
        const m = JSON.parse(p) as { type?: string; data?: Row };
        if (m.type === 'event' && m.data) events.push(m.data);
      },
      close: () => {},
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [collection] }),
    );
    const door: Door = {
      events,
      reconnect: async () => {},
      close: async () => websocketHandler.close(ws as never),
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

  for (const [name, collection, openDoor] of [
    ['WebSocket', WS_COL, wsDoor],
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

      // Step 2: the rule changes while subscribed, and the sweep is held — the
      // window every instance has between the change and the sweep's end.
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      // The sweep awaits this first, so holding it holds the whole sweep.
      const hold = spyOn(electric, 'interruptLivePolls').mockImplementation(
        (() => held) as unknown as typeof electric.interruptLivePolls,
      );
      try {
        await admin('PATCH', `/api/admin/rls/${ruleId}`, {
          filter_field: 'title',
          filter_op: 'eq',
          filter_value_source: 'static:shared',
        });
        const before = door.events.length;
        const hidden = await write(collection, { title: 'mine-now-hidden', owner: who.userId });
        const shown = await write(collection, { title: 'shared', salary: 'S3', owner: 'x' });
        await Bun.sleep(100);
        // GET already answers by the new rule: the old one's row is gone.
        expect(await served(collection, who, hidden)).toBeNull();
        expect(await served(collection, who, shown)).not.toBeNull();
        // Nothing the new rule hides was delivered; in fact nothing at all —
        // the scope is stale until the sweep re-resolves it.
        expect(door.events.map((e) => e.id)).not.toContain(hidden);
        expect(door.events.length).toBe(before);
      } finally {
        release();
        hold.mockRestore();
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

  it('while the bus is down a local write delivers nothing; after reconnect the next one does', async () => {
    await restrict(BUS_COL);
    const who = await member(BUS_COL);
    const doors = [await wsDoor(BUS_COL, who), await sseDoor(BUS_COL, who)];
    const bus = new PgNotifyRealtimeBus(process.env.TEST_DATABASE_URL as string);
    await bus.start();
    try {
      // The bus's LISTEN connection is cut, as a network partition would.
      const listen = (bus as unknown as { client: pg.Client & { processID: number } }).client;
      await sql`SELECT pg_terminate_backend(${listen.processID})`.execute(db);
      await until(() => busDeaf());
      expect(busDeaf()).toBe(true);

      const silent = await write(BUS_COL, { title: 'during', owner: who.userId });
      await Bun.sleep(100);
      expect(await served(BUS_COL, who, silent)).not.toBeNull(); // GET serves it
      for (const door of doors) expect(door.events.map((e) => e.id)).not.toContain(silent);

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
