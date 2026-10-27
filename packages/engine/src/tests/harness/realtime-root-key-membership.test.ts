/**
 * An open realtime connection opened with a ROOT-tenant API key in an ordinary
 * tenant, after the key's issuer stops being a member there.
 *
 * A root key acts in tenant T on its issuer's standing in T (`apiKeyActsIn`):
 * god, or a membership in force. The door asks that at open; the sweep did
 * not. `stillAuthenticated` checks the issuer against the KEY's tenant — root,
 * which counts everyone — and `stillInTenant` asked membership of sessions
 * only, so a socket or stream the key opened in T kept receiving T's writes
 * after the issuer's membership there lapsed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { __sweepIdle, DEFAULT_TENANT_ID, revalidateSockets } from '../../lib/tenancy/index.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { _wsPermCacheForTests, broadcastEvent, websocketHandler } from '../../routes/ws.js';
import {
  asKeyIssuer,
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const COLLECTION = `rkmem_${SFX}`;
const T = { id: crypto.randomUUID(), slug: `rkmem-${SFX.replace('_', '-')}` };
const KEY_NAME = `rkmem-${SFX}`;

d('an open root-key realtime connection after its issuer leaves the tenant', () => {
  let app: Hono;
  let db: Database;
  let godId = '';
  let lapsing = '';
  let steady = '';
  const probes: string[] = [];

  async function mintKey(createdBy: string) {
    const raw = generateApiKey();
    const row = await db
      .insertInto('zv_api_keys')
      .values({
        name: KEY_NAME,
        key_hash: await hashApiKey(raw),
        key_prefix: raw.substring(0, 12),
        scopes: sql`${JSON.stringify([{ collection: COLLECTION, actions: ['read'] }])}::jsonb`,
        created_by: createdBy,
        is_active: true,
        tenant_id: DEFAULT_TENANT_ID,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return { raw, id: (row as { id: string }).id };
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await createGodSession(app, db);
    godId = (
      await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god' LIMIT 1`.execute(db)
    ).rows[0]!.id;
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${T.id}::uuid, ${T.slug}, 'rkmem', 'active')`.execute(db);
    lapsing = await asKeyIssuer((await createMemberSession(app, db)).userId);
    steady = await asKeyIssuer((await createMemberSession(app, db)).userId);
    for (const u of [lapsing, steady]) {
      await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from, valid_to)
                VALUES (${T.id}::uuid, ${u}, 'member', now() - interval '1 day',
                        ${u === lapsing ? sql`now() + interval '1 hour'` : null})`.execute(db);
    }
  }, 60_000);

  afterAll(async () => {
    const { connections } = _wsPermCacheForTests();
    for (const id of probes) connections.delete(id);
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name = ${KEY_NAME}`.execute(db).catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${T.id}::uuid`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${T.id}::uuid`.execute(db).catch(() => {});
  });

  /** A socket opened through the real upgrade with `raw`, subscribed to COLLECTION. */
  async function openWs(raw: string, slug: string | null) {
    const data = await wsUpgradeData(app, {
      Authorization: `Bearer ${raw}`,
      ...(slug ? { 'x-tenant-slug': slug } : {}),
    });
    expect(data).toBeDefined();
    const id = `ws_rk_${probes.length}_${SFX}`;
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

  async function openSse(raw: string) {
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { 'X-API-Key': raw, 'x-tenant-slug': T.slug },
    });
    expect(res.status).toBe(200);
    await res.body!.getReader().read(); // `connected` — the stream is registered
  }

  const sseOpen = (keyId: string) =>
    [..._sseConnectionsForTests().values()].some((set) =>
      [...set].some((s) => s.tenantId === T.id && s.user.id === `apikey:${keyId}`),
    );

  async function sweep() {
    await __sweepIdle();
    revalidateSockets('principals');
    await __sweepIdle();
  }

  it("closes the lapsed issuer's key in T only — never a member's, a god's, or in the default tenant", async () => {
    const lapsingKey = await mintKey(lapsing);
    const steadyKey = await mintKey(steady);
    const godKey = await mintKey(godId);

    const lapsedWs = await openWs(lapsingKey.raw, T.slug);
    expect(lapsedWs.tenantId).toBe(T.id);
    const steadyWs = await openWs(steadyKey.raw, T.slug);
    const godWs = await openWs(godKey.raw, T.slug);
    // The default tenant counts everyone: the same key stays open there.
    const defaultWs = await openWs(lapsingKey.raw, null);
    expect(defaultWs.tenantId).toBe(DEFAULT_TENANT_ID);
    await openSse(lapsingKey.raw);
    await openSse(steadyKey.raw);
    expect(sseOpen(lapsingKey.id)).toBe(true);

    // The date passes. No event says so.
    await sql`UPDATE zv_tenant_users SET valid_to = now() - interval '1 second'
              WHERE tenant_id = ${T.id}::uuid AND user_id = ${lapsing}`.execute(db);

    // The door refuses the key in T now — the sweep must agree with it.
    const door = await app.request(`/api/data/${COLLECTION}`, {
      headers: { Authorization: `Bearer ${lapsingKey.raw}`, 'x-tenant-slug': T.slug },
    });
    expect(door.status).toBe(401);

    await sweep();

    expect(lapsedWs.closed()).not.toBeNull();
    expect(lapsedWs.delivered('after-lapse')).toBe(false);
    expect(sseOpen(lapsingKey.id)).toBe(false);

    for (const kept of [steadyWs, godWs, defaultWs]) {
      expect(kept.closed()).toBeNull();
      expect(kept.delivered(`kept-${probes.length}-${Math.random()}`)).toBe(true);
    }
    expect(sseOpen(steadyKey.id)).toBe(true);
  }, 60_000);
});
