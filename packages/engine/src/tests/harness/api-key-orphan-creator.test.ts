/**
 * An API key whose creator row is gone without `deleteUser`.
 *
 * `zv_api_keys.created_by` is `ON DELETE SET NULL`. `deleteUser` revokes a
 * user's keys before the row goes, but a user deleted by any other path —
 * direct SQL, an extension holding the admin handle, a restored backup — left
 * keys with a NULL creator, and the key lookup let a NULL creator pass both the
 * barred check and the membership check: the key kept reading, with no owner,
 * on REST, on new streams and on the streams already open. A key must have a
 * live, unbarred creator to authenticate.
 *
 * Keys are minted the way `POST /api/api-keys` mints them, with the caller as
 * `created_by`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { __sweepIdle, DEFAULT_TENANT_ID, revalidateSockets } from '../../lib/tenancy/index.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const COLLECTION = `keyorphan_${SFX}`;
const T = { id: crypto.randomUUID(), slug: `keyorphan-${SFX.replace('_', '-')}` };

d('an API key after its creator row is deleted outside deleteUser', () => {
  let app: Hono;
  let db: Database;

  async function mintKey(createdBy: string, tenantId: string) {
    const key = generateApiKey();
    const row = await db
      .insertInto('zv_api_keys')
      .values({
        name: `keyorphan-${SFX}`,
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

  const list = (key: string, slug?: string) =>
    app.request(`/api/data/${COLLECTION}`, {
      headers: { 'X-API-Key': key, ...(slug ? { 'x-tenant-slug': slug } : {}) },
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${T.id}::uuid, ${T.slug}, 'keyorphan', 'active')`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name = ${`keyorphan-${SFX}`}`
      .execute(db)
      .catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${T.id}::uuid`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${T.id}::uuid`.execute(db).catch(() => {});
  });

  it('refuses the orphaned key on REST and new streams, and ends its open stream', async () => {
    const gone = (await createMemberSession(app, db)).userId;
    const stays = (await createMemberSession(app, db)).userId;
    for (const u of [gone, stays]) {
      await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
                VALUES (${T.id}::uuid, ${u}, 'member')`.execute(db);
    }
    const inDefault = await mintKey(gone, DEFAULT_TENANT_ID);
    const inTenant = await mintKey(gone, T.id);
    const control = await mintKey(stays, T.id);

    expect((await list(inDefault.key)).status).toBe(200);
    expect((await list(inTenant.key, T.slug)).status).toBe(200);
    const stream = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { 'X-API-Key': inTenant.key, 'x-tenant-slug': T.slug },
    });
    expect(stream.status).toBe(200);
    expect(_sseConnectionsForTests().has(`apikey:${inTenant.id}`)).toBe(true);

    // Not `deleteUser`: the row goes and the FK nulls the creator.
    await sql`DELETE FROM "user" WHERE id = ${gone}`.execute(db);
    const orphaned = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_api_keys
      WHERE id IN (${inDefault.id}::uuid, ${inTenant.id}::uuid)
        AND created_by IS NULL AND is_active`.execute(db);
    expect(orphaned.rows[0]!.n).toBe(2);

    expect((await list(inDefault.key)).status).toBe(401);
    expect((await list(inTenant.key, T.slug)).status).toBe(401);
    const reopen = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { 'X-API-Key': inTenant.key, 'x-tenant-slug': T.slug },
    });
    expect(reopen.status).toBe(401);

    await __sweepIdle();
    revalidateSockets('principals');
    await __sweepIdle();
    expect(_sseConnectionsForTests().has(`apikey:${inTenant.id}`)).toBe(false);

    // Everyone else is untouched.
    expect((await list(control.key, T.slug)).status).toBe(200);
  }, 60_000);

  // Refused at the door, the key was still listed `is_active: true` on both
  // admin listings: they read the stored flag, not the rule the door applies.
  it('both key listings report the orphaned key inactive, from the rule the door applies', async () => {
    const cookie = await createGodSession(app, db);
    const gone = (await createMemberSession(app, db)).userId;
    const stays = (await createMemberSession(app, db)).userId;
    const orphan = await mintKey(gone, DEFAULT_TENANT_ID);
    const control = await mintKey(stays, DEFAULT_TENANT_ID);
    await sql`DELETE FROM "user" WHERE id = ${gone}`.execute(db);

    for (const path of ['/api/api-keys?limit=200', '/api/admin/api-keys?limit=200']) {
      const res = await app.request(path, { headers: { cookie } });
      expect(res.status).toBe(200);
      const { api_keys } = (await res.json()) as {
        api_keys: Array<{ id: string; is_active: boolean }>;
      };
      const status = (id: string) => api_keys.find((k) => k.id === id)?.is_active;
      expect([path, status(orphan.id), status(control.id)]).toEqual([path, false, true]);
    }
    expect((await list(orphan.key)).status).toBe(401);
    expect((await list(control.key)).status).toBe(200);
  }, 60_000);
});
