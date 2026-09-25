/**
 * Non-data channels (broadcast, presence) reach an SSE stream two ways: in
 * process from the publishing instance, and through the Valkey subscription
 * from every instance. Two defects lived in the Valkey handler:
 *
 * - it checked `record_id` / `?filter=` against these messages, with the
 *   channel name standing in for a collection, so a stream that set either
 *   never received a broadcast from another replica;
 * - the publishing instance's own message came back through Valkey, so its
 *   local streams received every broadcast twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { _setCacheForTests, ORIGIN_ID } from '../../lib/runtime/index.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

/** Just enough of a Valkey client: the subscriber's handler is captured. */
function fakeCache() {
  let onMessage: ((channel: string, message: string) => void) | undefined;
  const subscriber = {
    subscribe: async () => {},
    unsubscribe: async () => {},
    quit: async () => {},
    on: (_: string, fn: typeof onMessage) => {
      onMessage = fn;
    },
  };
  const cache = new Proxy(
    { duplicate: () => subscriber, publish: async () => 0 },
    { get: (t, k) => (k in t ? t[k as keyof typeof t] : async () => null) },
  );
  return { cache, deliver: (ch: string, msg: object) => onMessage?.(ch, JSON.stringify(msg)) };
}

d('realtime non-data channels over Valkey', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  const bus = fakeCache();

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    _setCacheForTests(bus.cache as never);
  });

  afterAll(() => _setCacheForTests(null));

  async function openStream(qs: string) {
    const res = await app.request(`/api/realtime/stream?${qs}`, { headers: { cookie: god } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // `connected`
    const sub = [..._sseConnectionsForTests().values()].flatMap((s) => [...s]).at(-1)!;
    const delivered: string[] = [];
    sub.stream.writeSSE = (msg: { data: string }) => {
      delivered.push(msg.data);
      return Promise.resolve();
    };
    return { reader, delivered };
  }

  it('a stream with record_id still receives a broadcast from another replica', async () => {
    const { reader, delivered } = await openStream('channel=broadcast:room&record_id=r1');
    bus.deliver('zveltio:broadcast:room', {
      event: 'ping',
      payload: 'FROM-REPLICA',
      originId: 'eng-other',
    });
    expect(delivered.join('\n')).toContain('FROM-REPLICA');
    await reader.cancel().catch(() => {});
  });

  it("drops this instance's own message coming back through Valkey", async () => {
    const { reader, delivered } = await openStream('channel=broadcast:room');
    bus.deliver('zveltio:broadcast:room', { event: 'ping', payload: 'ECHO', originId: ORIGIN_ID });
    expect(delivered.join('\n')).not.toContain('ECHO');
    await reader.cancel().catch(() => {});
  });
});
