/**
 * Invoking a non-public edge function needs `execute` on `$edge`.
 *
 * `/api/fn/:name` authenticated the caller and then ran the function: any
 * signed-in user of the tenant, and any valid key of it whatever its scopes,
 * ran any function — arbitrary code holding the function's `env_vars` secrets.
 * A session now needs Casbin `execute` on `$edge` (tenant_member holds it by
 * default, migration 094); a key needs a `$edge` scope naming `execute` or the
 * function, AND its issuer the same Casbin grant. Public functions
 * (`ZVELTIO_PUBLIC=true`) stay open to everyone, signed in or not.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/index.js';
import {
  asTenant,
  createGodSession,
  createKeyCreator,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const TAG = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const ROOT = '00000000-0000-0000-0000-000000000001';
const TENANT = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const FN = `perm-fn-${TAG}`;
const FN_OTHER = `perm-fn-other-${TAG}`;
const FN_PUB = `perm-fn-pub-${TAG}`;
const CODE = 'async function handler(){return {status:200,body:{ran:true}}}';

d('edge function invoke needs execute on $edge', () => {
  let app: Hono;
  let db: Database;
  let plain: { cookie: string; userId: string };
  let granted: { cookie: string };
  let tenantMember: { cookie: string; userId: string };
  const keys: Record<string, string> = {};

  const insertFn = (tenant: string, name: string, env: Record<string, string> = {}) =>
    asTenant(db, tenant, (trx) =>
      sql`
        INSERT INTO zv_edge_functions (tenant_id, name, display_name, code, http_method, path, env_vars)
        VALUES (${tenant}::uuid, ${name}, ${name}, ${CODE}, 'POST', ${`/api/fn/${name}`},
                ${JSON.stringify(env)}::jsonb)
      `.execute(trx),
    );

  const insertKey = async (label: string, scopes: unknown, issuer: string) => {
    const raw = generateApiKey();
    await sql`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
      VALUES (${`${FN}-${label}`}, ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
              ${JSON.stringify(scopes)}::jsonb, true, ${ROOT}::uuid, ${issuer})
    `.execute(db);
    keys[label] = raw;
  };

  const invoke = (name: string, headers: Record<string, string> = {}) =>
    app.request(`/api/fn/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    for (const [id, slug] of [
      [TENANT, `edge-perm-${TAG}`],
      [OTHER, `edge-perm-o-${TAG}`],
    ] as const) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}::uuid, ${slug}, ${slug}, 'active')`.execute(db);
    }
    await insertFn(ROOT, FN);
    await insertFn(ROOT, FN_OTHER);
    await insertFn(ROOT, FN_PUB, { ZVELTIO_PUBLIC: 'true' });
    await insertFn(TENANT, FN);
    await insertFn(OTHER, FN);

    plain = await createMemberSession(app, db);
    granted = await createMemberSession(app, db, {
      grants: [{ collection: '$edge', actions: ['execute'] }],
    });
    // An ordinary member of TENANT, as POST /api/tenants/:id/members makes one:
    // what the default grant (migration 094) is for.
    tenantMember = await createMemberSession(app, db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${TENANT}::uuid, ${tenantMember.userId}, 'member')`.execute(db);
    await (await getEnforcer()).addRoleForUser(tenantMember.userId, 'tenant_member', TENANT);
    await invalidateUserPermCache(tenantMember.userId);

    const admin = await createKeyCreator(db);
    await insertKey('data-only', [{ collection: '*', actions: ['*'] }], admin);
    await insertKey('edge-all', [{ collection: '$edge', actions: ['execute'] }], admin);
    await insertKey('edge-named', [{ collection: '$edge', actions: [FN] }], admin);
    await insertKey('plain-issuer', [{ collection: '$edge', actions: ['execute'] }], plain.userId);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${FN}-%`}`.execute(db).catch(() => {});
    for (const t of [ROOT, TENANT, OTHER]) {
      await asTenant(db, t, (trx) =>
        sql`DELETE FROM zv_edge_functions WHERE name IN (${FN}, ${FN_OTHER}, ${FN_PUB})`.execute(
          trx,
        ),
      ).catch(() => {});
    }
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id IN (${TENANT}::uuid, ${OTHER}::uuid)`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_permissions WHERE v2 IN (${TENANT}, ${OTHER})`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id IN (${TENANT}::uuid, ${OTHER}::uuid)`
      .execute(db)
      .catch(() => {});
  });

  it('a session with no edge grant is refused', async () => {
    expect((await invoke(FN, { cookie: plain.cookie })).status).toBe(403);
  });

  it('a session granted execute on $edge runs it', async () => {
    const res = await invoke(FN, { cookie: granted.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ran: true });
  });

  it('a key without a $edge scope is refused, however wide its data scope', async () => {
    expect((await invoke(FN, { 'X-API-Key': keys['data-only']! })).status).toBe(403);
  });

  it('a key with $edge execute runs any function', async () => {
    expect((await invoke(FN, { 'X-API-Key': keys['edge-all']! })).status).toBe(200);
    expect((await invoke(FN_OTHER, { 'X-API-Key': keys['edge-all']! })).status).toBe(200);
  });

  it('a key naming one function runs that one only', async () => {
    expect((await invoke(FN, { 'X-API-Key': keys['edge-named']! })).status).toBe(200);
    expect((await invoke(FN_OTHER, { 'X-API-Key': keys['edge-named']! })).status).toBe(403);
  });

  it('a key never exceeds its issuer', async () => {
    expect((await invoke(FN, { 'X-API-Key': keys['plain-issuer']! })).status).toBe(403);
  });

  it('a public function stays callable anonymously and by anyone signed in', async () => {
    expect((await invoke(FN_PUB)).status).toBe(200);
    expect((await invoke(FN_PUB, { cookie: plain.cookie })).status).toBe(200);
    expect((await invoke(FN_PUB, { 'X-API-Key': keys['data-only']! })).status).toBe(200);
  });

  it("a tenant member runs their tenant's function by default, and no other tenant's", async () => {
    const own = await invoke(FN, {
      cookie: tenantMember.cookie,
      'x-tenant-slug': `edge-perm-${TAG}`,
    });
    expect(own.status).toBe(200);
    const foreign = await invoke(FN, {
      cookie: tenantMember.cookie,
      'x-tenant-slug': `edge-perm-o-${TAG}`,
    });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.status).toBeLessThan(500);
  });

  it('the permission matrix offers $edge with execute', async () => {
    const res = await app.request('/api/admin/resources', {
      headers: { cookie: await createGodSession(app, db) },
    });
    const { resources } = (await res.json()) as {
      resources: Array<{ name: string; actions: string[] }>;
    };
    expect(resources.find((r) => r.name === '$edge')?.actions).toEqual(['execute']);
  });

  it('the default grant is the one migration 094 writes', async () => {
    const rows = await sql<{ v0: string }>`
      SELECT v0 FROM zvd_permissions
       WHERE ptype = 'p' AND v1 = '*' AND v2 = '$edge' AND v3 = 'execute'`.execute(db);
    // Other rows are this file's per-user grants (createMemberSession).
    const roles = rows.rows.map((r) => r.v0);
    expect(roles).toContain('tenant_member');
    expect(roles).not.toContain('tenant_viewer');
    expect(roles).not.toContain('member');
  });
});
