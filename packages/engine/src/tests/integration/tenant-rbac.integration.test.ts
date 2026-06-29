/**
 * Per-tenant RBAC (Casbin domains) — beta.19.
 *
 * Exercises the REAL checkPermission + getUserRoles + runWithDomain against the
 * actual Casbin model/adapter and Postgres. Proves:
 *   - behavior-preservation: a domain '*' grant/policy works in every tenant
 *     (how migration 008 reshapes all pre-existing policies);
 *   - per-tenant isolation: a tenant-scoped grant only applies in that tenant;
 *   - migration 008 reshape survives the (sub,obj) act-collision.
 *
 * Requires TEST_DATABASE_URL. Pure DB (no HTTP server needed). Shares the
 * migrated `zvd_permissions` table with other tests — so it NEVER drops it, uses
 * `rbactest_`-prefixed subjects, and cleans up only its own rows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';

process.env.BETTER_AUTH_SECRET ??= 'test-secret-32-chars-long-aaaaaaaa';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skipAll = !TEST_DB_URL;

let db: Database;
let checkPermission: typeof import('../../lib/permissions.js').checkPermission;
let runWithDomain: typeof import('../../lib/tenant-context.js').runWithDomain;
let getUserRoles: typeof import('../../lib/permissions.js').getUserRoles;

const A = '00000000-0000-0000-0000-0000000a000a';
const B = '00000000-0000-0000-0000-0000000b000b';
const MIG_TABLE = 'zvd_perm_mig_test'; // isolated table for the migration reshape

async function cleanupTestRows() {
  await sql`DELETE FROM zvd_permissions WHERE v0 LIKE 'rbactest_%' OR v1 LIKE 'rbactest_%'`
    .execute(db)
    .catch(() => {});
}

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);

  // The table exists in CI (migrated). In a bare test DB, create a minimal one.
  // NEVER drop it — other tests share it.
  await sql`
    CREATE TABLE IF NOT EXISTS zvd_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ptype TEXT NOT NULL, v0 TEXT, v1 TEXT, v2 TEXT, v3 TEXT, v4 TEXT, v5 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, role TEXT)`.execute(db);
  await cleanupTestRows();

  const tm = await import('../../lib/tenant-manager.js');
  tm.initTenantManager(db);
  const perms = await import('../../lib/permissions.js');
  await perms.initPermissions(db);
  checkPermission = perms.checkPermission;
  getUserRoles = perms.getUserRoles;
  runWithDomain = (await import('../../lib/tenant-context.js')).runWithDomain;

  const { getEnforcer } = perms;
  const e = await getEnforcer();
  await e.addPolicy('rbactest_editor', '*', 'rbactest_posts', 'read');
  await e.addRoleForUser('rbactest_bob', 'rbactest_editor', '*');
  await e.addPolicy('rbactest_admin', A, '*', '*');
  await e.addRoleForUser('rbactest_alice', 'rbactest_admin', A);
});

afterAll(async () => {
  if (skipAll || !db) return;
  await cleanupTestRows();
  await sql
    .raw(`DROP TABLE IF EXISTS "${MIG_TABLE}"`)
    .execute(db)
    .catch(() => {});
  await (db as any).destroy?.();
});

describe.skipIf(skipAll)('Per-tenant RBAC (Casbin domains)', () => {
  it('behavior-preserving: a global (*) grant works in any tenant', async () => {
    expect(
      await runWithDomain(A, () => checkPermission('rbactest_bob', 'rbactest_posts', 'read')),
    ).toBe(true);
    expect(
      await runWithDomain(B, () => checkPermission('rbactest_bob', 'rbactest_posts', 'read')),
    ).toBe(true);
  });

  it('global grant still denies actions it was not granted', async () => {
    expect(
      await runWithDomain(A, () => checkPermission('rbactest_bob', 'rbactest_posts', 'delete')),
    ).toBe(false);
  });

  it('per-tenant: alice is admin in tenant A', async () => {
    expect(
      await runWithDomain(A, () => checkPermission('rbactest_alice', 'secrets', 'delete')),
    ).toBe(true);
  });

  it('per-tenant isolation: alice has NO admin in tenant B', async () => {
    expect(
      await runWithDomain(B, () => checkPermission('rbactest_alice', 'secrets', 'delete')),
    ).toBe(false);
  });

  it('getUserRoles is domain-scoped', async () => {
    const inA = await runWithDomain(A, () => getUserRoles('rbactest_alice'));
    expect(inA).toContain('rbactest_admin');
    const inB = await runWithDomain(B, () => getUserRoles('rbactest_alice'));
    expect(inB).not.toContain('rbactest_admin');
  });

  it('migration 008 reshapes legacy rows + survives the (sub,obj) act-collision', async () => {
    const t = sql.id(MIG_TABLE);
    await sql`DROP TABLE IF EXISTS ${t}`.execute(db);
    await sql`CREATE TABLE ${t} (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ptype TEXT NOT NULL, v0 TEXT, v1 TEXT, v2 TEXT, v3 TEXT, v4 TEXT, v5 TEXT)`.execute(
      db,
    );
    // OLD 4-col unique index + legacy rows sharing (sub,obj), differing in act.
    await sql`CREATE UNIQUE INDEX ${sql.id('uq_' + MIG_TABLE)} ON ${t} (ptype, COALESCE(v0,''), COALESCE(v1,''), COALESCE(v2,''))`.execute(
      db,
    );
    await sql`INSERT INTO ${t} (ptype, v0, v1, v2) VALUES ('p','legacy_role','widgets','read'), ('p','legacy_role','widgets','write')`.execute(
      db,
    );
    await sql`INSERT INTO ${t} (ptype, v0, v1) VALUES ('g','legacy_user','legacy_role')`.execute(
      db,
    );
    // EXACT migration 008 shape: drop index → reshape → recreate including v3.
    await sql`DROP INDEX IF EXISTS ${sql.id('uq_' + MIG_TABLE)}`.execute(db);
    await sql`UPDATE ${t} SET v3=v2, v2=v1, v1='*' WHERE ptype='p' AND v3 IS NULL`.execute(db);
    await sql`UPDATE ${t} SET v2='*' WHERE ptype='g' AND v2 IS NULL`.execute(db);
    await sql`CREATE UNIQUE INDEX ${sql.id('uq_' + MIG_TABLE)} ON ${t} (ptype, COALESCE(v0,''), COALESCE(v1,''), COALESCE(v2,''), COALESCE(v3,''))`.execute(
      db,
    );

    const p = await sql<{
      v1: string;
      v2: string;
      v3: string;
    }>`SELECT v1, v2, v3 FROM ${t} WHERE ptype='p' AND v0='legacy_role' ORDER BY v3`.execute(db);
    expect(p.rows.length).toBe(2);
    expect(p.rows[0]).toMatchObject({ v1: '*', v2: 'widgets', v3: 'read' });
    const g = await sql<{
      v2: string;
    }>`SELECT v2 FROM ${t} WHERE ptype='g' AND v0='legacy_user'`.execute(db);
    expect(g.rows[0]?.v2).toBe('*');
    await sql`DROP TABLE IF EXISTS ${t}`.execute(db);
  });
});
