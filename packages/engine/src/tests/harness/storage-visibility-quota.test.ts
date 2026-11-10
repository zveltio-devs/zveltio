/**
 * ADR 0034 Q1 and Q3: who may change a stored file's visibility, who sees a
 * storage quota, and who may set one.
 *
 * - `PATCH /api/storage/:id` is allowed exactly where `DELETE` is (`deletableFile`,
 *   lib/stored-files.ts): the uploader or a tenant admin; 404 for a file the
 *   caller cannot read, 403 for one they can; a key needs `$storage` `update`.
 * - `GET /api/storage/quota` answers the caller's own usage, in this tenant.
 * - `PUT /api/admin/storage-quotas/:userId` (null for the default): a quota binds a user in
 *   every tenant, so god only, behind a step-up for `storage.quota:<userId>`,
 *   audited as `storage.quota_changed`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { DEFAULT_QUOTA_BYTES } from '../../lib/storage-quota.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  asKeyIssuer,
  asTenant,
  createMemberSession,
  createSteppedUpGod,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const TENANT = crypto.randomUUID();
const SLUG = `visq-${TENANT.slice(0, 8)}`;
const STAMP = `visq-${Date.now()}`;

d('storage visibility and quotas', () => {
  let app: Hono;
  let db: Database;
  let god: Awaited<ReturnType<typeof createSteppedUpGod>>;
  let alice: Awaited<ReturnType<typeof createMemberSession>>;
  let bob: Awaited<ReturnType<typeof createMemberSession>>;
  let admin: Awaited<ReturnType<typeof createMemberSession>>;
  const raw: Record<string, string> = {};
  const keyRow: Record<string, string> = {};

  const seed = async (o: {
    tenant?: string;
    visibility?: 'personal' | 'tenant';
    by: string;
    byKey?: string;
    size?: number;
    path?: string;
  }) =>
    (
      await asTenant(db, o.tenant ?? ROOT, (trx) =>
        trx
          .insertInto('zv_media_files')
          .values({
            tenant_id: o.tenant ?? ROOT,
            filename: STAMP,
            original_name: `${STAMP}.txt`,
            mimetype: 'text/plain',
            size: o.size ?? 0,
            storage_path: o.path ?? `uploads/harness/${STAMP}-${crypto.randomUUID()}`,
            visibility: o.visibility ?? 'personal',
            created_by: o.by,
            created_by_api_key: o.byKey ?? null,
          } as never)
          .returning('id')
          .executeTakeFirstOrThrow(),
      )
    ).id;

  const visibilityOf = async (id: string) =>
    (
      await asEveryTenant(db, (trx) =>
        trx
          .selectFrom('zv_media_files')
          .select('visibility')
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      )
    ).visibility;

  const patch = (id: string, auth: Record<string, string>, body: unknown) =>
    app.request(`/api/storage/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(body),
    });
  const quota = async (auth: Record<string, string>) => {
    const res = await app.request('/api/storage/quota', { headers: auth });
    expect(res.status).toBe(200);
    return (await res.json()) as { used_bytes: number; quota_bytes: number };
  };
  const setQuota = (
    userId: string,
    cookie: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.request(`/api/admin/storage-quotas/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie, ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createSteppedUpGod(app, db);
    alice = await createMemberSession(app, db);
    bob = await createMemberSession(app, db);
    // An instance admin with an open configuration window: everything god has
    // here but the god flag.
    admin = await createMemberSession(app, db, { configWindow: true });
    await (await getEnforcer()).addRoleForUser(admin.userId, 'admin', ROOT);
    await invalidateUserPermCache(admin.userId);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${TENANT}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    // Keys of an issuer (an administrator, so a key's reach is its scopes alone).
    const issuer = await asKeyIssuer((await createMemberSession(app, db)).userId);
    for (const [name, actions] of [
      ['upd', ['read', 'update']],
      ['del', ['read', 'delete']],
    ] as const) {
      raw[name] = generateApiKey();
      keyRow[name] = (
        await sql<{ id: string }>`
          INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
          VALUES (${`${STAMP}-${name}`}, ${await hashApiKey(raw[name]!)}, ${raw[name]!.slice(0, 12)},
                  ${JSON.stringify([{ collection: '$storage', actions }])}::jsonb, true,
                  ${ROOT}::uuid, ${issuer})
          RETURNING id`.execute(db)
      ).rows[0]!.id;
    }
    keyRow.issuer = issuer;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_media_files WHERE filename = ${STAMP}`.execute(trx),
    );
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${STAMP}-%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT}::uuid`.execute(db);
    await sql`DELETE FROM zv_storage_quotas WHERE user_id IN (${alice?.userId ?? ''}, ${bob?.userId ?? ''})`.execute(
      db,
    );
  });

  describe('PATCH /api/storage/:id', () => {
    it('lets the uploader share a file with the tenant and take it back', async () => {
      const id = await seed({ by: alice.userId });
      expect(
        (await app.request(`/api/storage/${id}`, { headers: { cookie: bob.cookie } })).status,
      ).toBe(404);

      const res = await patch(id, { cookie: alice.cookie }, { visibility: 'tenant' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { file: { visibility: string } }).file.visibility).toBe(
        'tenant',
      );
      expect(await visibilityOf(id)).toBe('tenant');
      expect(
        (await app.request(`/api/storage/${id}`, { headers: { cookie: bob.cookie } })).status,
      ).toBe(200);

      expect((await patch(id, { cookie: alice.cookie }, { visibility: 'personal' })).status).toBe(
        200,
      );
      expect(await visibilityOf(id)).toBe('personal');
    });

    it('refuses a colleague as DELETE does: 403 on a file they can read, 404 on one they cannot', async () => {
      const shared = await seed({ by: alice.userId, visibility: 'tenant' });
      const own = await seed({ by: alice.userId });
      const sharedRes = await patch(shared, { cookie: bob.cookie }, { visibility: 'personal' });
      expect(sharedRes.status).toBe(403);
      expect(await visibilityOf(shared)).toBe('tenant');
      const ownRes = await patch(own, { cookie: bob.cookie }, { visibility: 'tenant' });
      expect(ownRes.status).toBe(404);
      expect(await visibilityOf(own)).toBe('personal');
      // The same answers DELETE gives.
      expect(
        (
          await app.request(`/api/storage/${shared}`, {
            method: 'DELETE',
            headers: { cookie: bob.cookie },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`/api/storage/${own}`, {
            method: 'DELETE',
            headers: { cookie: bob.cookie },
          })
        ).status,
      ).toBe(404);
    });

    it('lets a tenant admin change any file of the tenant', async () => {
      const id = await seed({ by: alice.userId });
      expect((await patch(id, { cookie: admin.cookie }, { visibility: 'tenant' })).status).toBe(
        200,
      );
      expect(await visibilityOf(id)).toBe('tenant');
    });

    it('answers 404 for the uploader’s own file in another tenant', async () => {
      const id = await seed({ tenant: TENANT, by: alice.userId });
      expect((await patch(id, { cookie: alice.cookie }, { visibility: 'tenant' })).status).toBe(
        404,
      );
      expect(await visibilityOf(id)).toBe('personal');
    });

    it('needs $storage update of a key, even on a file the key uploaded', async () => {
      const byDel = await seed({ by: keyRow.issuer!, byKey: keyRow.del });
      const res = await patch(byDel, { 'X-API-Key': raw.del! }, { visibility: 'tenant' });
      expect(res.status).toBe(403);
      expect(await visibilityOf(byDel)).toBe('personal');

      const byUpd = await seed({ by: keyRow.issuer!, byKey: keyRow.upd });
      expect((await patch(byUpd, { 'X-API-Key': raw.upd! }, { visibility: 'tenant' })).status).toBe(
        200,
      );
      expect(await visibilityOf(byUpd)).toBe('tenant');
    });

    it('refuses a visibility it does not know, and a public file made personal', async () => {
      const id = await seed({ by: alice.userId });
      for (const body of [{}, { visibility: 'public' }, { visibility: 1 }]) {
        expect((await patch(id, { cookie: alice.cookie }, body)).status).toBe(400);
      }
      const pub = await seed({
        by: alice.userId,
        visibility: 'tenant',
        path: `public/uploads/${STAMP}-${crypto.randomUUID()}`,
      });
      expect((await patch(pub, { cookie: alice.cookie }, { visibility: 'personal' })).status).toBe(
        409,
      );
      expect(await visibilityOf(pub)).toBe('tenant');
    });
  });

  describe('GET /api/storage/quota', () => {
    it('answers the caller’s own bytes in this tenant and their own allowance', async () => {
      // Fresh users, so the sums are only what is seeded here.
      const carol = await createMemberSession(app, db);
      const dave = await createMemberSession(app, db);
      await seed({ by: carol.userId, size: 1000 });
      await seed({ by: carol.userId, size: 50, tenant: TENANT });
      await seed({ by: dave.userId, size: 7, visibility: 'tenant' });
      await sql`INSERT INTO zv_storage_quotas (user_id, quota_bytes) VALUES (${carol.userId}, 123456)`.execute(
        db,
      );
      try {
        expect(await quota({ cookie: carol.cookie })).toEqual({
          used_bytes: 1000,
          quota_bytes: 123456,
        });
        expect(await quota({ cookie: dave.cookie })).toEqual({
          used_bytes: 7,
          quota_bytes: DEFAULT_QUOTA_BYTES,
        });
      } finally {
        await sql`DELETE FROM zv_storage_quotas WHERE user_id = ${carol.userId}`.execute(db);
      }
    });

    it('answers a key with its issuer’s', async () => {
      const issuerUse = (
        await sql<{
          n: string;
        }>`SELECT zveltio_media_used_bytes(${ROOT}::uuid, ${keyRow.issuer!}) AS n`.execute(db)
      ).rows[0]!.n;
      expect(await quota({ 'X-API-Key': raw.upd! })).toEqual({
        used_bytes: Number(issuerUse),
        quota_bytes: DEFAULT_QUOTA_BYTES,
      });
    });
  });

  describe('PUT /api/admin/storage-quotas/:userId', () => {
    const action = (id: string) => `storage.quota:${id}`;
    const audits = async (userId: string) =>
      (
        await sql<{ user_id: string; metadata: Record<string, unknown> }>`
          SELECT user_id, metadata FROM zv_audit_log
           WHERE event_type = 'storage.quota_changed' AND resource_id = ${userId}
           ORDER BY created_at`.execute(db)
      ).rows;

    it('refuses an instance admin who is not god, step-up and all', async () => {
      const res = await setQuota(bob.userId, admin.cookie, {
        body: { quota_bytes: 1 },
        headers: await admin.stepUp!(action(bob.userId)),
      });
      expect(res.status).toBe(403);
      expect(await audits(bob.userId)).toHaveLength(0);
      const row = await sql`SELECT 1 FROM zv_storage_quotas WHERE user_id = ${bob.userId}`.execute(
        db,
      );
      expect(row.rows).toHaveLength(0);
    });

    it('refuses god without a step-up for this user', async () => {
      // `app`, not `god.app`: the door would step up for it. The window is open.
      const res = await setQuota(bob.userId, god.cookie, { body: { quota_bytes: 1 } });
      expect(res.status).toBe(403);
      // The handler's own step-up, not the configuration window's.
      expect(await res.json()).toMatchObject({
        code: 'step_up_required',
        errors: { action: action(bob.userId) },
      });
      const other = await setQuota(bob.userId, god.cookie, {
        body: { quota_bytes: 1 },
        headers: await god.stepUp(action(alice.userId)),
      });
      expect(other.status).toBe(403);
      const row = await sql`SELECT 1 FROM zv_storage_quotas WHERE user_id = ${bob.userId}`.execute(
        db,
      );
      expect(row.rows).toHaveLength(0);
    });

    it('lets god set and remove a quota, audited, and the user sees it', async () => {
      expect(
        (
          await setQuota(bob.userId, god.cookie, {
            body: { quota_bytes: -1 },
            headers: await god.stepUp(action(bob.userId)),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await setQuota('no-such-user', god.cookie, {
            body: { quota_bytes: 1 },
            headers: await god.stepUp(action('no-such-user')),
          })
        ).status,
      ).toBe(404);

      const set = await setQuota(bob.userId, god.cookie, {
        body: { quota_bytes: 2048 },
        headers: await god.stepUp(action(bob.userId)),
      });
      expect(set.status).toBe(200);
      expect((await quota({ cookie: bob.cookie })).quota_bytes).toBe(2048);

      const del = await setQuota(bob.userId, god.cookie, {
        body: { quota_bytes: null },
        headers: await god.stepUp(action(bob.userId)),
      });
      expect(del.status).toBe(200);
      expect((await quota({ cookie: bob.cookie })).quota_bytes).toBe(DEFAULT_QUOTA_BYTES);

      await _settleAuditWrites();
      const rows = await audits(bob.userId);
      expect(rows.map((r) => [r.metadata.quota_bytes, r.metadata.previous])).toEqual([
        [2048, null],
        [null, 2048],
      ]);
      const me = await app.request('/api/me', { headers: { cookie: god.cookie } });
      const godId = ((await me.json()) as { user: { id: string } }).user.id;
      expect(rows.every((r) => r.user_id === godId && r.metadata.confirmed_by === 'passkey')).toBe(
        true,
      );
    });
  });
});
