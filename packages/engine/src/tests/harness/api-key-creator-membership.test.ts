/**
 * An API key bound to a tenant after its creator stops belonging there.
 *
 * The key lookup refused the keys of a barred creator but never asked whether
 * the creator still held a membership in the key's tenant. A member whose
 * membership lapsed (`valid_to` passed — also how SCIM suspends a user in one
 * tenant) or who was removed from the tenant lost every session door there and
 * kept full use of their keys: REST, new streams, and the streams already open.
 *
 * Keys are minted the way `POST /api/api-keys` mints them, with the member as
 * `created_by`; that route needs an admin, which is beside the point here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { __sweepIdle, DEFAULT_TENANT_ID, revalidateSockets } from '../../lib/tenancy/index.js';
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
const COLLECTION = `keymem_${SFX}`;
const T = { id: crypto.randomUUID(), slug: `keymem-${SFX.replace('_', '-')}` };

d('an API key after its creator leaves the key tenant', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let godId = '';
  const members: Record<'current' | 'lapsing' | 'removed', string> = {
    current: '',
    lapsing: '',
    removed: '',
  };
  const probes: string[] = [];

  async function mintKey(createdBy: string, tenantId: string) {
    const key = generateApiKey();
    const row = await db
      .insertInto('zv_api_keys')
      .values({
        name: `keymem-${SFX}`,
        key_hash: await hashApiKey(key),
        key_prefix: key.substring(0, 12),
        scopes: sql`${JSON.stringify([{ collection: COLLECTION, actions: ['read'] }])}::jsonb`,
        created_by: createdBy,
        is_active: true,
        tenant_id: tenantId,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return { key, id: row.id };
  }

  const headers = (key: string, inTenant = true): Record<string, string> => ({
    'X-API-Key': key,
    ...(inTenant ? { 'x-tenant-slug': T.slug } : {}),
  });
  const list = (key: string, inTenant = true) =>
    app.request(`/api/data/${COLLECTION}`, { headers: headers(key, inTenant) });
  const openSse = (key: string) =>
    app.request(`/api/realtime/stream?collection=${COLLECTION}`, { headers: headers(key) });
  const sseOpen = (keyId: string) => _sseConnectionsForTests().has(`apikey:${keyId}`);

  async function openWs(key: string) {
    const data = await wsUpgradeData(app, headers(key));
    expect(data?.authType).toBe('api_key');
    const id = `ws_keymem_${probes.length}_${SFX}`;
    probes.push(id);
    let closed = false;
    const ws = { data: { ...data, id }, send: () => {}, close: () => (closed = true) };
    websocketHandler.open(ws as never);
    return () => closed;
  }

  async function sweep() {
    await __sweepIdle();
    revalidateSockets('principals');
    await __sweepIdle();
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    godId = (
      await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god' LIMIT 1`.execute(db)
    ).rows[0]!.id;
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${T.id}::uuid, ${T.slug}, 'keymem', 'active')`.execute(db);
    for (const k of Object.keys(members) as (keyof typeof members)[]) {
      members[k] = (await createMemberSession(app, db)).userId;
      await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from, valid_to)
                VALUES (${T.id}::uuid, ${members[k]}, 'member', now() - interval '1 day',
                        now() + interval '1 hour')`.execute(db);
    }
  }, 60_000);

  afterAll(async () => {
    const { connections } = _wsPermCacheForTests();
    for (const id of probes) connections.delete(id);
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name = ${`keymem-${SFX}`}`.execute(db).catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${T.id}::uuid`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${T.id}::uuid`.execute(db).catch(() => {});
  });

  it('a lapsed membership refuses the key on REST and new streams, and ends its open ones', async () => {
    const lapsing = await mintKey(members.lapsing, T.id);
    const current = await mintKey(members.current, T.id);
    const lapsingDefault = await mintKey(members.lapsing, DEFAULT_TENANT_ID);
    // A god is exempt from membership, as at the middleware: not enrolled in T.
    const godKey = await mintKey(godId, T.id);

    for (const k of [lapsing, current, godKey]) expect((await list(k.key)).status).toBe(200);
    expect((await list(lapsingDefault.key, false)).status).toBe(200);

    expect((await openSse(lapsing.key)).status).toBe(200);
    expect((await openSse(current.key)).status).toBe(200);
    expect(sseOpen(lapsing.id)).toBe(true);
    const lapsingWsClosed = await openWs(lapsing.key);
    const currentWsClosed = await openWs(current.key);

    // The date passes. No event says so.
    await sql`UPDATE zv_tenant_users SET valid_to = now() - interval '1 second'
              WHERE tenant_id = ${T.id}::uuid AND user_id = ${members.lapsing}`.execute(db);

    // What a barred creator's key gets.
    expect((await list(lapsing.key)).status).toBe(401);
    expect((await openSse(lapsing.key)).status).toBe(401);

    await sweep();
    expect(sseOpen(lapsing.id)).toBe(false);
    expect(lapsingWsClosed()).toBe(true);

    // Everyone else is untouched.
    expect((await list(current.key)).status).toBe(200);
    expect(sseOpen(current.id)).toBe(true);
    expect(currentWsClosed()).toBe(false);
    expect((await list(godKey.key)).status).toBe(200);
    // The default tenant counts everyone.
    expect((await list(lapsingDefault.key, false)).status).toBe(200);
  }, 60_000);

  it('removing the member from the tenant refuses their key there', async () => {
    const removed = await mintKey(members.removed, T.id);
    expect((await list(removed.key)).status).toBe(200);

    const res = await app.request(`/api/tenants/${T.id}/members/${members.removed}`, {
      method: 'DELETE',
      headers: { cookie: god },
    });
    expect(res.status).toBe(200);

    expect((await list(removed.key)).status).toBe(401);
  }, 60_000);
});
