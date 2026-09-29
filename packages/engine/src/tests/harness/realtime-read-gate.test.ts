/**
 * The realtime doors read through the read gate (`readScope`).
 *
 * WS and SSE applied row policies and column permissions, and nothing else: an
 * extension's query alter or entity-access rule hid a row from `GET /api/data`
 * and the same row arrived as an event. The SSE wildcard stream applied
 * nothing at all — no gate had been resolved for it, and a missing gate was
 * read as "deliver".
 *
 * An alter cannot run on an event (there is no query), so a collection whose
 * alters restrict the reader refuses the subscription. An entity check is
 * async, so delivery queues behind it and keeps write order.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager, queryAlterRegistry } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { _sseConnectionsForTests, broadcastDataEvent } from '../../routes/realtime.js';
import { broadcastEvent, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `rtgate_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const OWNER = 'harness-realtime-gate';

async function settle(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(10);
}

d('realtime doors honour the read gate (in-process)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member: { cookie: string; userId: string };
  let memberWs: Record<string, unknown> | undefined;
  const sockets: unknown[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection: COLLECTION, actions: ['read', 'list'] }],
    });
    memberWs = await wsUpgradeData(app, { cookie: member.cookie });
  });

  afterEach(async () => {
    queryAlterRegistry.unregisterAll(OWNER);
    entityAccessRegistry.unregisterAll(OWNER);
    for (const ws of sockets.splice(0)) websocketHandler.close(ws as never);
    for (const r of readers.splice(0)) await r.cancel().catch(() => {});
  });

  afterAll(async () => {
    if (db) await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  async function subscribe(id: string) {
    const sent: string[] = [];
    const ws = { data: { ...memberWs, id, tenantId: null }, send: (p: string) => sent.push(p) };
    sockets.push(ws);
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    return sent;
  }

  async function stream(cookie: string, userId: string, qs: string) {
    const res = await app.request(`/api/realtime/stream?${qs}`, { headers: { cookie } });
    if (res.status !== 200) return { status: res.status, delivered: [] as string[] };
    const reader = res.body!.getReader();
    readers.push(reader);
    await reader.read(); // `connected`
    const sub = [..._sseConnectionsForTests().get(userId)!].at(-1)!;
    const delivered: string[] = [];
    const realWrite = sub.stream.writeSSE.bind(sub.stream);
    sub.stream.writeSSE = (msg: { data: string; event?: string }) => {
      delivered.push(msg.data);
      return realWrite(msg);
    };
    return { status: 200, delivered, tenantId: sub.tenantId };
  }

  const titleIsNot = (title: string) => (qb: any) => qb.where('title', '<>', title);
  const deny = (title: string) => (r: { title?: string }) =>
    r.title === title ? ('deny' as const) : ('allow' as const);

  it('WS: a collection whose alter restricts the reader refuses the subscription', async () => {
    queryAlterRegistry.registerAs(OWNER, TABLE, titleIsNot('hidden'));
    const sent = await subscribe('rtgate_ws_alter');
    const reply = sent
      .map((p) => JSON.parse(p) as { type: string; collections: string[]; denied: string[] })
      .find((m) => m.type === 'subscribed')!;
    expect(reply.denied).toContain(COLLECTION);
    expect(reply.collections).not.toContain(COLLECTION);
  });

  it('WS: entity access drops a denied event and keeps write order', async () => {
    // Slow for the first event, so a later event could overtake it.
    entityAccessRegistry.registerAs(OWNER, TABLE, async (r: { title?: string }) => {
      if (r.title === 'first') await Bun.sleep(30);
      return r.title === 'hidden' ? 'deny' : 'allow';
    });
    const sent = await subscribe('rtgate_ws_entity');
    sent.length = 0;
    for (const title of ['first', 'hidden', 'second'])
      broadcastEvent(COLLECTION, 'insert', { id: title, title }, null);
    await settle(() => sent.length >= 2);
    await Bun.sleep(20);
    expect(sent.map((p) => (JSON.parse(p) as { data: { title: string } }).data.title)).toEqual([
      'first',
      'second',
    ]);
  });

  it('SSE: a stream on only an alter-restricted collection is refused', async () => {
    queryAlterRegistry.registerAs(OWNER, TABLE, titleIsNot('hidden'));
    const res = await stream(member.cookie, member.userId, `collection=${COLLECTION}`);
    expect(res.status).toBe(403);
  });

  it('SSE: entity access drops a denied event', async () => {
    entityAccessRegistry.registerAs(OWNER, TABLE, deny('hidden'));
    const s = await stream(member.cookie, member.userId, `collection=${COLLECTION}`);
    for (const title of ['hidden', 'shown'])
      broadcastDataEvent(COLLECTION, 'insert', { id: title, title }, s.tenantId ?? null);
    await settle(() => s.delivered.length >= 1);
    await Bun.sleep(20);
    expect(s.delivered.join('\n')).toContain('shown');
    expect(s.delivered.join('\n')).not.toContain('hidden');
  });

  it('SSE: the wildcard stream applies the gate too', async () => {
    const godId = (await db
      .selectFrom('user' as never)
      .select('id' as never)
      .where('role' as never, '=', 'god' as never)
      .executeTakeFirstOrThrow()) as { id: string };
    entityAccessRegistry.registerAs(OWNER, TABLE, deny('hidden'));
    const s = await stream(god, godId.id, '');
    expect(s.status).toBe(200);
    for (const title of ['hidden', 'shown'])
      broadcastDataEvent(COLLECTION, 'insert', { id: title, title }, s.tenantId ?? null);
    await settle(() => s.delivered.length >= 1);
    await Bun.sleep(20);
    expect(s.delivered.join('\n')).toContain('shown');
    expect(s.delivered.join('\n')).not.toContain('hidden');
  });
});
