/**
 * `POST /api/rpc/:fn` takes an API key holding `$rpc` for `execute`.
 *
 * It was session-only: a valid key got 403 "Session required", so a program
 * could not call a whitelisted function at all. The key is held to the data
 * path's model (`guardSessionOrKey` in lib/admin-guard.ts): the scope must be
 * named — a `*` data key does not reach it — and the function runs in the
 * request's tenant transaction as `zveltio_rls`, under the key's own RLS actor,
 * never its issuer's.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const TENANT = crypto.randomUUID();
const SLUG = `krpc-${TENANT.slice(0, 8)}`;
const STAMP = `krpc-${Date.now()}`;
const WHOAMI = 'harness_rpc_key_whoami';
const ROWS = 'harness_rpc_key_rows';
const ADMIN_FN = 'harness_rpc_key_admin';
const OFF_FN = 'harness_rpc_key_off';
const UNLISTED = 'harness_rpc_key_unlisted';
// Named like an action word: `write` must not reach it through the `create` alias.
const CREATE_FN = 'create';

type Scope = { collection: string; actions: string[] };
const RPC: Scope[] = [{ collection: '$rpc', actions: ['execute'] }];
const KEYS: Record<string, { scopes: Scope[]; tenant: string; active?: false; bypass?: true }> = {
  data: { scopes: [{ collection: '*', actions: ['*'] }], tenant: ROOT },
  read: { scopes: [{ collection: '$rpc', actions: ['read'] }], tenant: ROOT },
  rpc: { scopes: RPC, tenant: ROOT },
  bypass: { scopes: RPC, tenant: ROOT, bypass: true },
  revoked: { scopes: RPC, tenant: ROOT, active: false },
  tenant: { scopes: RPC, tenant: TENANT },
  named: { scopes: [{ collection: '$rpc', actions: [WHOAMI, OFF_FN] }], tenant: ROOT },
  write: { scopes: [{ collection: '$rpc', actions: ['write'] }], tenant: ROOT },
};
const raw: Record<string, string> = {};
const keyId: Record<string, string> = {};

type WhoAmI = {
  user_id: string;
  user_role: string;
  tenant: string;
  bypass: string;
  db_role: string;
};

d('rpc with an API key', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let member = '';

  const call = (key: string | null, fn: string, body: unknown = {}, slug?: string) =>
    app.request(`/api/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'X-API-Key': raw[key]! } : {}),
        ...(slug ? { 'X-Tenant-Slug': slug } : {}),
      },
      body: JSON.stringify(body),
    });

  const rows = async <T>(res: Response): Promise<T[]> => {
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: T[] }).data;
  };

  const fn = (name: string, body: string) =>
    sql.raw(`CREATE OR REPLACE FUNCTION "${name}"${body}`).execute(db);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    ({ cookie, userId: member } = await createMemberSession(app, db));
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${TENANT}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    // What the function itself sees: the RLS actor, the tenant and the database role.
    await fn(
      WHOAMI,
      `() RETURNS TABLE(user_id text, user_role text, tenant text, bypass text, db_role text)
       LANGUAGE sql STABLE AS $$
         SELECT current_setting('zveltio.user_id', true), current_setting('zveltio.user_role', true),
                current_setting('zveltio.current_tenant', true),
                current_setting('zveltio.rls_bypass', true), current_user::text $$`,
    );
    // A table under the tenant RLS policy, as every collection is.
    await fn(
      ROWS,
      `(stamp text) RETURNS TABLE(tenant_id uuid) LANGUAGE sql STABLE AS $$
         SELECT tenant_id FROM zv_record_comments WHERE collection = stamp $$`,
    );
    for (const name of [ADMIN_FN, OFF_FN, UNLISTED, CREATE_FN])
      await fn(name, `() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'ok'::text $$`);
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name LIKE 'harness_rpc_key_%'`.execute(
      db,
    );
    await sql`
      INSERT INTO zvd_rpc_functions (function_name, required_role, is_enabled) VALUES
        (${WHOAMI}, 'member', true), (${ROWS}, 'member', true),
        (${ADMIN_FN}, 'admin', true), (${OFF_FN}, 'member', false)
    `.execute(db);
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${CREATE_FN}`.execute(db);
    await sql`INSERT INTO zvd_rpc_functions (function_name, required_role, is_enabled)
              VALUES (${CREATE_FN}, 'member', true)`.execute(db);
    for (const [name, k] of Object.entries(KEYS)) {
      raw[name] = generateApiKey();
      const row = await sql<{ id: string }>`
        INSERT INTO zv_api_keys
          (name, key_hash, key_prefix, scopes, is_active, rls_bypass, tenant_id, created_by)
        VALUES (${`${STAMP}-${name}`}, ${await hashApiKey(raw[name]!)}, ${raw[name]!.slice(0, 12)},
                ${JSON.stringify(k.scopes)}::jsonb, ${k.active ?? true}, ${k.bypass ?? false},
                ${k.tenant}::uuid, ${member})
        RETURNING id::text AS id
      `.execute(db);
      keyId[name] = row.rows[0]!.id;
    }
    for (const tenant of [ROOT, TENANT])
      await sql`INSERT INTO zv_record_comments (collection, record_id, comment, tenant_id)
                VALUES (${STAMP}, ${STAMP}, ${STAMP}, ${tenant}::uuid)`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name LIKE 'harness_rpc_key_%'`.execute(
      db,
    );
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${CREATE_FN}`.execute(db);
    for (const name of [WHOAMI, ADMIN_FN, OFF_FN, UNLISTED, CREATE_FN])
      await sql.raw(`DROP FUNCTION IF EXISTS "${name}"()`).execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS "${ROWS}"(text)`).execute(db);
    await sql`DELETE FROM zv_record_comments WHERE collection = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${STAMP}-%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT}::uuid`.execute(db);
  });

  it('refuses a key without $rpc execute with 403 — a `*` data key included', async () => {
    expect((await call('data', WHOAMI)).status).toBe(403);
    expect((await call('read', WHOAMI)).status).toBe(403);
  });

  it('answers 401 to nobody, a revoked key and another tenant’s key', async () => {
    expect((await call(null, WHOAMI)).status).toBe(401);
    expect((await call('revoked', WHOAMI)).status).toBe(401);
    expect((await call('tenant', WHOAMI)).status).toBe(401);
  });

  it('runs the function as zveltio_rls under the key’s own actor, not its issuer', async () => {
    const [me] = await rows<WhoAmI>(await call('rpc', WHOAMI));
    expect(me).toEqual({
      user_id: `apikey:${keyId.rpc}`,
      user_role: 'api_key',
      tenant: ROOT,
      bypass: 'off',
      db_role: 'zveltio_rls',
    });
    const [bypass] = await rows<WhoAmI>(await call('bypass', WHOAMI));
    expect(bypass!.user_id).toBe(`apikey:${keyId.bypass}`);
    expect(bypass!.bypass).toBe('on');
  });

  it('keeps tenant isolation inside the function', async () => {
    const root = await rows<{ tenant_id: string }>(await call('rpc', ROWS, { stamp: STAMP }));
    expect(root.map((r) => r.tenant_id)).toEqual([ROOT]);
    // `rls_bypass` stands down row rules, never the tenant boundary.
    const bypass = await rows<{ tenant_id: string }>(await call('bypass', ROWS, { stamp: STAMP }));
    expect(bypass.map((r) => r.tenant_id)).toEqual([ROOT]);
    const tenant = await rows<{ tenant_id: string }>(
      await call('tenant', ROWS, { stamp: STAMP }, SLUG),
    );
    expect(tenant.map((r) => r.tenant_id)).toEqual([TENANT]);
    const [me] = await rows<WhoAmI>(await call('tenant', WHOAMI, {}, SLUG));
    expect(me!.tenant).toBe(TENANT);
  });

  it('refuses a disabled or unlisted function as it refuses a session', async () => {
    for (const name of [OFF_FN, UNLISTED]) {
      expect((await call('rpc', name)).status).toBe(404);
      const session = await app.request(`/api/rpc/${name}`, {
        method: 'POST',
        headers: { cookie },
      });
      expect(session.status).toBe(404);
    }
  });

  it('lets the scope, not a role, stand where required_role does for a session', async () => {
    // The floor ranks a session's roles; a key has none — its grant is the scope.
    const session = await app.request(`/api/rpc/${ADMIN_FN}`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(session.status).toBe(403);
    expect((await call('rpc', ADMIN_FN)).status).toBe(200);
  });

  it('lets a key naming functions call those only; `execute` calls every one', async () => {
    expect((await call('named', WHOAMI)).status).toBe(200);
    // Whitelisted, not named → 403; unlisted, not named → 403 too, so a narrow
    // key cannot probe the whitelist. Named but disabled → 404, as for a session.
    expect((await call('named', ADMIN_FN)).status).toBe(403);
    expect((await call('named', UNLISTED)).status).toBe(403);
    expect((await call('named', OFF_FN)).status).toBe(404);
    for (const name of [WHOAMI, ADMIN_FN, CREATE_FN])
      expect((await call('rpc', name)).status).toBe(200);
  });

  it('matches function names exactly — `write` does not grant a function named create', async () => {
    expect((await call('write', CREATE_FN)).status).toBe(403);
  });

  it('leaves a session as it was', async () => {
    const res = await app.request(`/api/rpc/${WHOAMI}`, { method: 'POST', headers: { cookie } });
    const [me] = await rows<WhoAmI>(res);
    expect(me!.user_id).toBe(member);
    expect(me!.user_role).not.toBe('api_key');
    expect(me!.db_role).toBe('zveltio_rls');
  });
});
