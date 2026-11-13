/**
 * A tenant administrator mints the tenant's API keys (ADR 0046 decision 2).
 *
 * At `/api/api-keys`, whatever `member_api_keys` says: the administrator of the
 * request's tenant lists, mints and revokes that tenant's keys, never another
 * tenant's nor the instance's (root-tenant) keys. A plain member is still
 * refused. The key is its author (ADR 0028): bound to the tenant it was minted
 * in, it reaches nothing in another one, and it reaches no more than its author
 * does now.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import {
  DEFAULT_TENANT_ID,
  getEnforcer,
  invalidateUserPermCache,
} from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}`.slice(-8) + `${Math.floor(Math.random() * 1e4)}`;
const A = { id: crypto.randomUUID(), slug: `taak-a-${TAG}` };
const B = { id: crypto.randomUUID(), slug: `taak-b-${TAG}` };
const COLL = `taak_${TAG}`;
const NAME = `taak-${TAG}`;

type Who = Awaited<ReturnType<typeof createMemberSession>>;

d('a tenant administrator mints the tenant keys (ADR 0046)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let adminA: Who;
  let memberA: Who;
  let adminB: Who;

  const call = (
    path: string,
    opts: { cookie?: string; key?: string; slug?: string; method?: string; body?: unknown } = {},
  ) =>
    app.request(path, {
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.key ? { 'X-API-Key': opts.key } : {}),
        ...(opts.slug ? { 'x-tenant-slug': opts.slug } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });

  const mint = (who: string, slug: string | undefined, scopes: unknown[]) =>
    call('/api/api-keys', { cookie: who, slug, method: 'POST', body: { name: NAME, scopes } });

  const listed = async (who: string, slug: string) => {
    const res = await call('/api/api-keys?limit=200', { cookie: who, slug });
    expect(res.status).toBe(200);
    return ((await res.json()) as { api_keys: Array<{ id: string }> }).api_keys.map((k) => k.id);
  };

  const active = async (id: string) =>
    (
      await sql<{
        a: boolean;
      }>`SELECT is_active AS a FROM zv_api_keys WHERE id = ${id}::uuid`.execute(db)
    ).rows[0]?.a;

  /** A member of `tenant`, its administrator when `admin`. */
  const memberOf = async (tenant: string, admin: boolean) => {
    const m = await createMemberSession(app, db, { configWindow: true });
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${tenant}::uuid, ${m.userId}, 'member')`.execute(db);
    if (admin) await (await getEnforcer()).addRoleForUser(m.userId, 'tenant_admin', tenant);
    await invalidateUserPermCache(m.userId);
    return m;
  };

  /** A key inserted by hand, as `issuer` in `tenant`: what the auth path reads. */
  const plant = async (issuer: string, tenant: string, memberIssued = false) => {
    const raw = generateApiKey();
    const row = await sql<{ id: string }>`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, created_by, is_active,
                               tenant_id, member_issued, request_count)
      VALUES (${NAME}, ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
              ${JSON.stringify([{ collection: '*', actions: ['*'] }])}::jsonb, ${issuer}, true,
              ${tenant}::uuid, ${memberIssued}, 0)
      RETURNING id`.execute(db);
    return { raw, id: row.rows[0]!.id };
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await sql`DELETE FROM zv_settings WHERE key = 'member_api_keys'`.execute(db);
    for (const t of [A, B])
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${t.id}::uuid, ${t.slug}, ${t.slug}, 'active')`.execute(db);
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (const t of [A, B])
      await sql`INSERT INTO ${sql.table(`zvd_${COLL}`)} (tenant_id, title)
                VALUES (${t.id}::uuid, ${`row-of-${t.slug}`})`.execute(db);
    adminA = await memberOf(A.id, true);
    memberA = await memberOf(A.id, false);
    adminB = await memberOf(B.id, true);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name = ${NAME}`.execute(db);
    const e = await getEnforcer();
    for (const u of [adminA, adminB]) if (u) await e.deleteRolesForUser(u.userId).catch(() => {});
    for (const t of [A, B]) {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${t.id}::uuid`.execute(db);
      await sql`DELETE FROM ${sql.table(`zvd_${COLL}`)} WHERE tenant_id = ${t.id}::uuid`
        .execute(db)
        .catch(() => {});
    }
    await dropTestCollection(db, COLL).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id IN (${A.id}::uuid, ${B.id}::uuid)`.execute(db);
  });

  // ADR 0046's precondition: verified before the route opened, and kept.
  it('a key bound to tenant A reaches nothing in tenant B: data, realtime, /ext, self', async () => {
    const key = await plant(adminA.userId, A.id);
    // In A it is somebody.
    expect((await call('/api/api-keys/self', { key: key.raw, slug: A.slug })).status).toBe(200);
    expect((await call(`/api/data/${COLL}`, { key: key.raw, slug: A.slug })).status).toBe(200);
    expect((await call('/ext/nothing/here', { key: key.raw, slug: A.slug })).status).toBe(403);
    // In B, and in the root tenant, it is nobody.
    for (const slug of [B.slug, undefined]) {
      for (const path of [
        '/api/api-keys/self',
        `/api/data/${COLL}`,
        `/api/data/${COLL}/bulk`,
        `/api/realtime/stream?collection=${COLL}`,
        '/ext/nothing/here',
      ]) {
        const res = await call(path, { key: key.raw, slug });
        expect([slug ?? 'root', path, res.status]).toEqual([slug ?? 'root', path, 401]);
      }
    }
  });

  it('mints with member_api_keys off; the key is bound to the tenant and its author', async () => {
    const res = await mint(adminA.cookie, A.slug, [{ collection: COLL, actions: ['read'] }]);
    expect(res.status).toBe(200);
    const { id, key } = (await res.json()) as { id: string; key: string };
    const row = (
      await sql<{ tenant_id: string; created_by: string; member_issued: boolean }>`
        SELECT tenant_id::text, created_by, member_issued FROM zv_api_keys WHERE id = ${id}::uuid`.execute(
        db,
      )
    ).rows[0];
    expect(row).toEqual({ tenant_id: A.id, created_by: adminA.userId, member_issued: false });

    const inA = await call(`/api/data/${COLL}`, { key, slug: A.slug });
    expect(inA.status).toBe(200);
    const titles = ((await inA.json()) as { records: Array<{ title: string }> }).records.map(
      (r) => r.title,
    );
    expect(titles).toEqual([`row-of-${A.slug}`]);
    expect((await call(`/api/data/${COLL}`, { key, slug: B.slug })).status).toBe(401);
  });

  it('a plain member is still refused, on both doors', async () => {
    const scopes = [{ collection: COLL, actions: ['read'] }];
    expect((await mint(memberA.cookie, A.slug, scopes)).status).toBe(403);
    expect((await call('/api/api-keys', { cookie: memberA.cookie, slug: A.slug })).status).toBe(
      403,
    );
    const own = await call('/api/me/api-keys', {
      cookie: memberA.cookie,
      slug: A.slug,
      method: 'POST',
      body: {
        name: NAME,
        scopes,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(own.status).toBe(403);
    expect(((await own.json()) as { code: string }).code).toBe('member_api_keys_off');
  });

  it("lists and revokes its own tenant's keys only: not tenant B's, not the instance's", async () => {
    const scopes = [{ collection: COLL, actions: ['read'] }];
    const mine = ((await (await mint(adminA.cookie, A.slug, scopes)).json()) as { id: string }).id;
    const members = (await plant(memberA.userId, A.id, true)).id;
    const res = await mint(adminB.cookie, B.slug, scopes);
    expect(res.status).toBe(200);
    const theirs = ((await res.json()) as { id: string }).id;
    const root = (await (await mint(god, undefined, scopes)).json()) as {
      id: string;
      tenant_id: string;
    };
    expect(root.tenant_id).toBe(DEFAULT_TENANT_ID);

    const seen = await listed(adminA.cookie, A.slug);
    expect(seen).toContain(mine);
    expect(seen).toContain(members);
    expect(seen).not.toContain(theirs);
    expect(seen).not.toContain(root.id);

    for (const id of [theirs, root.id]) {
      const del = await call(`/api/api-keys/${id}`, {
        cookie: adminA.cookie,
        slug: A.slug,
        method: 'DELETE',
      });
      expect(del.status).toBe(404);
      expect(await active(id)).toBe(true);
    }
    // A member's key in the tenant is the tenant's: its administrator revokes it.
    const del = await call(`/api/api-keys/${members}`, {
      cookie: adminA.cookie,
      slug: A.slug,
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    expect(await active(members)).toBe(false);
  });

  it('administers only the tenant it is administrator of, never the root tenant', async () => {
    const before = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM zv_api_keys WHERE created_by = ${adminA.userId}`.execute(db);
    const scopes = [{ collection: COLL, actions: ['read'] }];
    // B: not a member there. Root: the instance's keys. Unknown: no tenant at all.
    for (const slug of [B.slug, undefined, `taak-none-${TAG}`]) {
      const list = await call('/api/api-keys', { cookie: adminA.cookie, slug });
      expect([slug, list.status === 200]).toEqual([slug, false]);
      const made = await mint(adminA.cookie, slug, scopes);
      expect([slug, made.status === 200]).toEqual([slug, false]);
    }
    const after = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM zv_api_keys WHERE created_by = ${adminA.userId}`.execute(db);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    // The instance's per-key limits stay god's.
    const own = (await (await mint(adminA.cookie, A.slug, scopes)).json()) as { id: string };
    const limit = await call(`/api/api-keys/${own.id}/rate-limit`, {
      cookie: adminA.cookie,
      slug: A.slug,
      method: 'PUT',
      body: { window_ms: 60_000, max_requests: 5 },
    });
    expect(limit.status).toBe(403);
  });

  it('the key reaches no more than its author does now', async () => {
    const admin = await memberOf(A.id, true);
    const res = await mint(admin.cookie, A.slug, [{ collection: '*', actions: ['*'] }]);
    expect(res.status).toBe(200);
    const { key } = (await res.json()) as { key: string };
    expect((await call(`/api/data/${COLL}`, { key, slug: A.slug })).status).toBe(200);
    // Demoted to a plain member, who holds no grant on the collection.
    await (await getEnforcer()).deleteRoleForUser(admin.userId, 'tenant_admin', A.id);
    await invalidateUserPermCache(admin.userId);
    expect((await call(`/api/data/${COLL}`, { key, slug: A.slug })).status).toBe(403);
  });
});
