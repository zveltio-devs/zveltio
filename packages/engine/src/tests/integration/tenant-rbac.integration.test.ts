/**
 * Per-tenant RBAC (Casbin domains) — beta.19.
 *
 * Exercises the REAL checkPermission + getUserRoles + runWithDomain against the
 * actual Casbin model/adapter and Postgres. Proves:
 *   - behavior-preservation: a domain '*' grant/policy works in every tenant
 *     (how migration 008 reshapes all pre-existing policies);
 *   - per-tenant isolation: a tenant-scoped grant only applies in that tenant;
 *   - migration 008 reshape leaves authorization unchanged.
 *
 * Requires TEST_DATABASE_URL. Pure DB (no HTTP server needed).
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

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);

  // Minimal tables the permission layer touches.
  await sql`DROP TABLE IF EXISTS zvd_permissions`.execute(db);
  await sql`
    CREATE TABLE zvd_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ptype TEXT NOT NULL, v0 TEXT, v1 TEXT, v2 TEXT, v3 TEXT, v4 TEXT, v5 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`.execute(db);
  // "user" table so isGodUser() can run (none of our test users are god).
  await sql`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, role TEXT)`.execute(db);

  const tm = await import('../../lib/tenant-manager.js');
  tm.initTenantManager(db);
  const perms = await import('../../lib/permissions.js');
  await perms.initPermissions(db);
  checkPermission = perms.checkPermission;
  getUserRoles = perms.getUserRoles;
  runWithDomain = (await import('../../lib/tenant-context.js')).runWithDomain;

  const { getEnforcer } = perms;
  const e = await getEnforcer();
  // Global (migrated) policy + grant: editor can read posts in EVERY tenant.
  await e.addPolicy('editor', '*', 'posts', 'read');
  await e.addRoleForUser('global_bob', 'editor', '*');
  // Per-tenant: alice is admin only in tenant A.
  await e.addPolicy('admin', A, '*', '*');
  await e.addRoleForUser('alice', 'admin', A);
});

afterAll(async () => {
  if (skipAll || !db) return;
  await sql`DROP TABLE IF EXISTS zvd_permissions`.execute(db);
  await (db as any).destroy?.();
});

describe.skipIf(skipAll)('Per-tenant RBAC (Casbin domains)', () => {
  it('behavior-preserving: a global (*) grant works in any tenant', async () => {
    expect(await runWithDomain(A, () => checkPermission('global_bob', 'posts', 'read'))).toBe(true);
    expect(await runWithDomain(B, () => checkPermission('global_bob', 'posts', 'read'))).toBe(true);
  });

  it('global grant still denies actions it was not granted', async () => {
    expect(await runWithDomain(A, () => checkPermission('global_bob', 'posts', 'delete'))).toBe(
      false,
    );
  });

  it('per-tenant: alice is admin in tenant A', async () => {
    expect(await runWithDomain(A, () => checkPermission('alice', 'secrets', 'delete'))).toBe(true);
  });

  it('per-tenant isolation: alice has NO admin in tenant B', async () => {
    expect(await runWithDomain(B, () => checkPermission('alice', 'secrets', 'delete'))).toBe(false);
  });

  it('getUserRoles is domain-scoped', async () => {
    const inA = await runWithDomain(A, () => getUserRoles('alice'));
    expect(inA).toContain('admin');
    const inB = await runWithDomain(B, () => getUserRoles('alice'));
    expect(inB).not.toContain('admin');
  });

  it('migration 008 reshapes legacy rows + survives the (sub,obj) act-collision', async () => {
    // Reproduce production: the OLD 4-col unique index + legacy rows that share
    // (sub, obj) and differ only in act — these collided on (sub, '*', obj)
    // until migration 008 widened the index to include v3.
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_zvd_permissions_policy_unique
      ON zvd_permissions (ptype, COALESCE(v0,''), COALESCE(v1,''), COALESCE(v2,''))`.execute(db);
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES
      ('p', 'legacy_role', 'widgets', 'read'), ('p', 'legacy_role', 'widgets', 'write')`.execute(
      db,
    );
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1) VALUES ('g', 'legacy_user', 'legacy_role')`.execute(
      db,
    );
    // Apply the EXACT migration 008 SQL (drop index → reshape → recreate w/ v3).
    await sql`DROP INDEX IF EXISTS idx_zvd_permissions_policy_unique`.execute(db);
    await sql`UPDATE zvd_permissions SET v3 = v2, v2 = v1, v1 = '*' WHERE ptype = 'p' AND v3 IS NULL`.execute(
      db,
    );
    await sql`UPDATE zvd_permissions SET v2 = '*' WHERE ptype = 'g' AND v2 IS NULL`.execute(db);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_zvd_permissions_policy_unique
      ON zvd_permissions (ptype, COALESCE(v0,''), COALESCE(v1,''), COALESCE(v2,''), COALESCE(v3,''))`.execute(
      db,
    );

    const p = await sql<{ v1: string; v2: string; v3: string }>`
      SELECT v1, v2, v3 FROM zvd_permissions WHERE ptype='p' AND v0='legacy_role' ORDER BY v3`.execute(
      db,
    );
    expect(p.rows.length).toBe(2); // both survived (no collision)
    expect(p.rows[0]).toMatchObject({ v1: '*', v2: 'widgets', v3: 'read' });
    const g = await sql<{ v2: string }>`
      SELECT v2 FROM zvd_permissions WHERE ptype='g' AND v0='legacy_user'`.execute(db);
    expect(g.rows[0]?.v2).toBe('*');
  });
});
