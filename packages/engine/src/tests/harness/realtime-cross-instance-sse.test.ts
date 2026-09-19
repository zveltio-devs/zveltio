/**
 * A write on another replica never reached an SSE subscriber.
 *
 * `realtimeBus` is the cross-instance fan-out: every replica publishes its
 * writes and every other replica receives them in `dispatchToWs`, which — as
 * its name said — called `broadcastEvent` in `routes/ws.ts` and nothing else.
 * The SSE stream keeps its own Valkey subscription to `zveltio:data:<name>`,
 * but nothing in the engine publishes to those channels, so with two replicas
 * a WebSocket client saw every write and an SSE client saw only the writes made
 * by the replica it happened to be connected to.
 *
 * Measured on a live engine with a real Valkey bus (two engines, one publish
 * from the other's origin): 0 events delivered before the repair, 1 after.
 * This suite is the in-process regression guard for the same path.
 *
 * It asserts on the subscription rather than on the HTTP body: `app.request`
 * does not surface stream writes made after the first flush, so a body-based
 * assertion cannot tell delivery from silence.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dispatchToWs } from '../../lib/runtime/realtime-bus.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `xinst_${Date.now()}`;

d('cross-instance writes reach SSE subscribers', () => {
  let app: Hono;
  let db: Database;
  let member: { cookie: string; userId: string };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection: COLLECTION, actions: ['read', 'list'] }],
    });
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('delivers a record.created published by another replica', async () => {
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    // Consume the body so the stream handler runs and registers the subscription.
    const reader = res.body!.getReader();
    await reader.read();

    const subs = _sseConnectionsForTests().get(member.userId);
    expect(subs?.size).toBe(1);
    const sub = [...subs!][0]!;

    const delivered: string[] = [];
    const realWrite = sub.stream.writeSSE.bind(sub.stream);
    sub.stream.writeSSE = (msg: { data: string; event?: string }) => {
      delivered.push(msg.data);
      return realWrite(msg);
    };

    dispatchToWs({
      originId: 'another-replica',
      event: 'record.created',
      collection: COLLECTION,
      record_id: 'r1',
      data: { id: 'r1', title: 'from-replica-b' },
      timestamp: new Date().toISOString(),
      // The tenant the stream was opened under: delivery requires equality, so
      // a null here would drop the event for a reason that has nothing to do
      // with the path under test.
      tenantId: sub.tenantId,
    });

    expect(delivered.join('\n')).toContain('from-replica-b');
    await reader.cancel().catch(() => {});
  });
});
