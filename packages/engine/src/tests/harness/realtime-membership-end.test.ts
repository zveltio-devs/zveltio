/**
 * An open realtime connection when its user's membership is ended or removed —
 * by an identity-provisioning extension or by the admin route — must close at
 * once, not at the next periodic principal sweep (30-60 s,
 * `realtime-membership-lapse.test.ts` covers that one).
 *
 * `setTenantMembershipEnd` wrote `valid_to` and asked for no sweep, so a member
 * SCIM suspended kept receiving the tenant's writes until the timer came round.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { __sweepIdle, getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { _wsPermCacheForTests, websocketHandler } from '../../routes/ws.js';
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
const COLLECTION = `wsend_${SFX}`;
const T = { id: crypto.randomUUID(), slug: `wsend-${SFX.replace('_', '-')}` };

d('an open realtime connection when its membership is ended or removed', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let ext: Database;
  const probes: string[] = [];
  const scim = gateInternals('auth/scim', buildExtensionInternals(), ['identity:provision']);
  const as = <R>(fn: (trx: Database) => Promise<R>) =>
    buildExtensionInternals().withTenantIsolation(T.id, () => fn(ext));

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    ext = createRestrictedDb(() => getCurrentTenantTrx() ?? db, 'auth/scim', new Set());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${T.id}::uuid, ${T.slug}, 'wsend', 'active')`.execute(db);
  }, 60_000);

  afterAll(async () => {
    const { connections } = _wsPermCacheForTests();
    for (const id of probes) connections.delete(id);
    if (!db) return;
    await dropTestCollection(db, COLLECTION).catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${T.id}::uuid`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${T.id}::uuid`.execute(db).catch(() => {});
  });

  /** A member of T with a subscribed socket and an open stream there. */
  async function connectedMember() {
    const m = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read'] }],
    });
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${T.id}::uuid, ${m.userId}, 'member')`.execute(db);
    const data = await wsUpgradeData(app, { cookie: m.cookie, 'x-tenant-slug': T.slug });
    expect(data).toBeDefined();
    const id = `ws_end_${probes.length}_${SFX}`;
    probes.push(id);
    const sent: string[] = [];
    let closed = false;
    const ws = {
      data: { ...data, id },
      send: (p: string) => sent.push(p),
      close: () => {
        closed = true;
      },
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    expect(sent.join('\n')).toContain('"type":"subscribed"');
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { cookie: m.cookie, 'x-tenant-slug': T.slug },
    });
    expect(res.status).toBe(200);
    await res.body!.getReader().read();
    const sseOpen = () =>
      [..._sseConnectionsForTests().values()].some((set) =>
        [...set].some((s) => s.tenantId === T.id && s.user.id === m.userId),
      );
    expect(sseOpen()).toBe(true);
    return { userId: m.userId, wsClosed: () => closed, sseOpen };
  }

  it('setTenantMembershipEnd(now) closes the socket and the stream at once', async () => {
    const m = await connectedMember();
    expect(await as((trx) => scim.setTenantMembershipEnd(trx, m.userId, 'now'))).toMatchObject({
      changed: true,
    });
    await __sweepIdle();
    expect(m.wsClosed()).toBe(true);
    expect(m.sseOpen()).toBe(false);
  }, 60_000);

  it('removeTenantMember closes the socket and the stream at once', async () => {
    const m = await connectedMember();
    expect((await as((trx) => scim.removeTenantMember(trx, m.userId))).removed).toBe(true);
    await __sweepIdle();
    expect(m.wsClosed()).toBe(true);
    expect(m.sseOpen()).toBe(false);
  }, 60_000);

  it('DELETE /api/tenants/:id/members/:userId closes the socket and the stream at once', async () => {
    const m = await connectedMember();
    const res = await app.request(`/api/tenants/${T.id}/members/${m.userId}`, {
      method: 'DELETE',
      headers: { cookie: god },
    });
    expect(res.status).toBe(200);
    await __sweepIdle();
    expect(m.wsClosed()).toBe(true);
    expect(m.sseOpen()).toBe(false);
  }, 60_000);
});
