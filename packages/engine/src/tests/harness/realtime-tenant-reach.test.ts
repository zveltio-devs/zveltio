/**
 * DR-33 (ADR 0058 decision 6): the realtime fan-out delivers what `GET` reads.
 *
 * A reader in a parent tenant reads the subtree through the data API, but the
 * fan-out matched the subscriber's tenant to the write's by equality, so a write
 * in a child never reached them — on the WebSocket, the SSE stream or the
 * wildcard stream. The fan-out now admits a write whose tenant is in the
 * subscriber's reach, resolved with the read gate under the access generation.
 *
 * The tree and the reach (`parent_id`, `status`, `read_scope`, `scope_list`)
 * change by SQL only, with no event. `reconcileRules` fingerprints them, so the
 * tick that catches a lost rule event also bumps the generation for a reach
 * change, and the sweep re-resolves every subscription by the new reach.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { __sweepIdle, reconcileRules } from '../../lib/tenancy/index.js';
import { _sseConnectionsForTests, broadcastDataEvent } from '../../routes/realtime.js';
import { _wsPermCacheForTests, broadcastEvent, websocketHandler } from '../../routes/ws.js';
import {
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const COLLECTION = `rtreach_${SFX}`;
const slug = (k: string) => `rtreach-${k}-${SFX.replace('_', '-')}`;
const PARENT = { id: crypto.randomUUID(), slug: slug('p') };
const CHILD = { id: crypto.randomUUID(), slug: slug('c') };
const OTHER = { id: crypto.randomUUID(), slug: slug('o') };

async function settle(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(10);
}

d('the realtime fan-out delivers the tenants the subscriber reads (DR-33)', () => {
  let app: Hono;
  let db: Database;
  let member: { cookie: string; userId: string };
  const probes: string[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (const t of [PARENT, CHILD, OTHER]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status, parent_id)
                VALUES (${t.id}::uuid, ${t.slug}, ${t.slug}, 'active',
                        ${t === CHILD ? PARENT.id : null}::uuid)`.execute(db);
    }
    // `admin` on `*`: the wildcard stream is a tenant admin's.
    member = await createMemberSession(app, db, {
      grants: [
        { collection: COLLECTION, actions: ['read'] },
        { collection: 'admin', actions: ['*'] },
      ],
    });
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, read_scope)
              VALUES (${PARENT.id}::uuid, ${member.userId}, 'member', 'subtree')`.execute(db);
  }, 60_000);

  afterAll(async () => {
    for (const r of readers) await r.cancel().catch(() => {});
    const { connections } = _wsPermCacheForTests();
    for (const id of probes) connections.delete(id);
    if (!db) return;
    await dropTestCollection(db, COLLECTION).catch(() => {});
    const ids = [PARENT.id, CHILD.id, OTHER.id];
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ANY(${ids}::uuid[])`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ANY(${ids}::uuid[])`.execute(db).catch(() => {});
  });

  async function openWs() {
    const data = await wsUpgradeData(app, { cookie: member.cookie, 'x-tenant-slug': PARENT.slug });
    expect(data).toBeDefined();
    const id = `ws_reach_${probes.length}_${SFX}`;
    probes.push(id);
    const sent: string[] = [];
    const ws = { data: { ...data, id }, send: (p: string) => sent.push(p), close: () => {} };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    expect(sent.join('\n')).toContain('"type":"subscribed"');
    return sent;
  }

  async function openSse(query: string) {
    const before = new Set(_sseConnectionsForTests().get(member.userId) ?? []);
    const res = await app.request(`/api/realtime/stream${query}`, {
      headers: { cookie: member.cookie, 'x-tenant-slug': PARENT.slug },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    readers.push(reader);
    await reader.read(); // `connected` — the stream is registered
    const sub = [..._sseConnectionsForTests().get(member.userId)!].find((s) => !before.has(s))!;
    const sent: string[] = [];
    const realWrite = sub.stream.writeSSE.bind(sub.stream);
    sub.stream.writeSSE = (msg: { data: string }) => {
      sent.push(msg.data);
      return realWrite(msg);
    };
    return sent;
  }

  let n = 0;
  /** A write in `tenant`, through both fan-outs: which doors delivered it. */
  async function heard(doors: string[][], tenant: { id: string }): Promise<boolean[]> {
    const rid = `r${n++}-${SFX}`;
    for (const sent of doors) sent.length = 0;
    broadcastEvent(COLLECTION, 'insert', { id: rid, title: rid }, tenant.id);
    broadcastDataEvent(COLLECTION, 'insert', { id: rid, title: rid }, tenant.id);
    // The wildcard stream resolves its gate on first use, asynchronously.
    await settle(() => doors.every((s) => s.join('').includes(rid)));
    await Bun.sleep(20);
    return doors.map((s) => s.join('').includes(rid));
  }

  /** What the reconcile tick does for a change no event carried. */
  async function tick() {
    expect(await reconcileRules()).toBe(true);
    await __sweepIdle();
  }

  it('delivers the subtree, refuses outside it, and follows a reach change made by SQL', async () => {
    await reconcileRules(); // baseline, as at boot
    const doors = [await openWs(), await openSse(`?collection=${COLLECTION}`), await openSse('')];

    expect(await heard(doors, PARENT)).toEqual([true, true, true]);
    // The child is in the parent member's subtree: GET reads it, so does the stream.
    expect(await heard(doors, CHILD)).toEqual([true, true, true]);
    expect(await heard(doors, OTHER)).toEqual([false, false, false]);

    // The child leaves the tree. No event says so.
    await sql`UPDATE zv_tenants SET parent_id = NULL WHERE id = ${CHILD.id}::uuid`.execute(db);
    await tick();
    expect(await heard(doors, CHILD)).toEqual([false, false, false]);
    expect(await heard(doors, PARENT)).toEqual([true, true, true]);

    // A list reach names the other tenant.
    await sql`UPDATE zv_tenant_users SET read_scope = 'list', scope_list = ARRAY[${OTHER.id}]::uuid[]
              WHERE tenant_id = ${PARENT.id}::uuid AND user_id = ${member.userId}`.execute(db);
    await tick();
    expect(await heard(doors, OTHER)).toEqual([true, true, true]);
    expect(await heard(doors, CHILD)).toEqual([false, false, false]);

    // Back to its own node.
    await sql`UPDATE zv_tenant_users SET read_scope = 'self', scope_list = NULL
              WHERE tenant_id = ${PARENT.id}::uuid AND user_id = ${member.userId}`.execute(db);
    await tick();
    expect(await heard(doors, OTHER)).toEqual([false, false, false]);
    expect(await heard(doors, PARENT)).toEqual([true, true, true]);

    // A status change is part of the fingerprint too.
    await sql`UPDATE zv_tenants SET status = 'suspended' WHERE id = ${OTHER.id}::uuid`.execute(db);
    await tick();
    expect(await reconcileRules()).toBe(false);
  }, 60_000);
});
