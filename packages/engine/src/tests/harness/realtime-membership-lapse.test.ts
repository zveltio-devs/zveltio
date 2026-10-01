/**
 * An open realtime connection after its user's tenant membership lapses.
 *
 * The membership middleware refuses a new request once `valid_to` has passed
 * (`activeMembership`), but a socket or stream is admitted once, at open, and
 * the sweep re-asked only its session or key and its tenant's status. A lapse
 * is a date, not an event, so the member kept receiving the tenant's writes for
 * as long as the connection stayed up.
 *
 * The periodic principal sweep (`startPolicyReconcile`'s tick is
 * `revalidateSockets('principals')`) is what a date passing reaches; this drives
 * that sweep directly instead of waiting 30-60 s for the timer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { __sweepIdle, DEFAULT_TENANT_ID, revalidateSockets } from '../../lib/tenancy/index.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { _wsPermCacheForTests, broadcastEvent, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const COLLECTION = `wsmem_${SFX}`;
const T = { id: crypto.randomUUID(), slug: `wsmem-${SFX.replace('_', '-')}` };

type Member = { cookie: string; userId: string };

d('an open realtime connection after its tenant membership lapses', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let current: Member;
  let lapsing: Member;
  const probes: string[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${T.id}::uuid, ${T.slug}, 'wsmem', 'active')`.execute(db);
    const grants = [{ collection: COLLECTION, actions: ['read'] }];
    current = await createMemberSession(app, db, { grants });
    lapsing = await createMemberSession(app, db, { grants });
    for (const m of [current, lapsing]) {
      await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from, valid_to)
                VALUES (${T.id}::uuid, ${m.userId}, 'member', now() - interval '1 day',
                        ${m === lapsing ? sql`now() + interval '1 hour'` : null})`.execute(db);
    }
  }, 60_000);

  afterAll(async () => {
    const { connections } = _wsPermCacheForTests();
    for (const id of probes) connections.delete(id);
    if (!db) return;
    await sql`ALTER TABLE IF EXISTS zv_tenant_users_moved RENAME TO zv_tenant_users`
      .execute(db)
      .catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${T.id}::uuid`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${T.id}::uuid`.execute(db).catch(() => {});
  });

  /** A socket opened through the real upgrade and subscribed to COLLECTION. */
  async function openWs(cookie: string, slug: string | null) {
    const data = await wsUpgradeData(app, { cookie, ...(slug ? { 'x-tenant-slug': slug } : {}) });
    expect(data).toBeDefined();
    const id = `ws_mem_${probes.length}_${SFX}`;
    probes.push(id);
    const sent: string[] = [];
    let closed: { code: number; reason: string } | null = null;
    const ws = {
      data: { ...data, id },
      send: (p: string) => sent.push(p),
      close: (code: number, reason: string) => {
        closed = { code, reason };
      },
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    expect(sent.join('\n')).toContain('"type":"subscribed"');
    const tenantId = ((ws.data as Record<string, unknown>).tenantId as string | null) ?? null;
    const delivered = (rid: string) => {
      sent.length = 0;
      broadcastEvent(COLLECTION, 'insert', { id: rid, title: rid }, tenantId);
      return sent.join('').includes(`"${rid}"`);
    };
    return { tenantId, closed: () => closed, delivered };
  }

  async function openSse(cookie: string) {
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { cookie, 'x-tenant-slug': T.slug },
    });
    expect(res.status).toBe(200);
    await res.body!.getReader().read(); // `connected` — the stream is registered
  }

  const sseOpen = (userId: string) =>
    [..._sseConnectionsForTests().values()].some((set) =>
      [...set].some((s) => s.tenantId === T.id && s.user.id === userId),
    );

  async function sweep() {
    await __sweepIdle();
    revalidateSockets('principals');
    await __sweepIdle();
  }

  it('closes the lapsed member only — not on a lookup error, and never a god or the default tenant', async () => {
    const lapsedWs = await openWs(lapsing.cookie, T.slug);
    expect(lapsedWs.tenantId).toBe(T.id);
    const currentWs = await openWs(current.cookie, T.slug);
    // A god is exempt from membership, as at the middleware.
    const godWs = await openWs(god, T.slug);
    // The default tenant counts everyone; nobody is enrolled in it.
    const defaultWs = await openWs(lapsing.cookie, null);
    expect(defaultWs.tenantId).toBe(DEFAULT_TENANT_ID);
    await openSse(lapsing.cookie);
    await openSse(current.cookie);
    expect(sseOpen(lapsing.userId)).toBe(true);

    // The date passes. No event says so.
    await sql`UPDATE zv_tenant_users SET valid_to = now() - interval '1 second'
              WHERE tenant_id = ${T.id}::uuid AND user_id = ${lapsing.userId}`.execute(db);

    // A membership lookup that fails is not a lapse: nothing closes.
    await sql`ALTER TABLE zv_tenant_users RENAME TO zv_tenant_users_moved`.execute(db);
    try {
      await sweep();
    } finally {
      await sql`ALTER TABLE zv_tenant_users_moved RENAME TO zv_tenant_users`.execute(db);
    }
    for (const s of [lapsedWs, currentWs, godWs, defaultWs]) expect(s.closed()).toBeNull();
    expect(sseOpen(lapsing.userId)).toBe(true);
    expect(sseOpen(current.userId)).toBe(true);

    await sweep();

    expect(lapsedWs.closed()).not.toBeNull();
    expect(lapsedWs.delivered('after-lapse')).toBe(false);
    expect(sseOpen(lapsing.userId)).toBe(false);

    for (const kept of [currentWs, godWs, defaultWs]) {
      expect(kept.closed()).toBeNull();
      expect(kept.delivered(`kept-${probes.length}`)).toBe(true);
    }
    expect(sseOpen(current.userId)).toBe(true);
  }, 60_000);
});
