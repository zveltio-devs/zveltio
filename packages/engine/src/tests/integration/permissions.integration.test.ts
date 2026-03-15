/**
 * Permissions — Integration Tests
 *
 * Tests Casbin RBAC + Emergency Admin Access end-to-end.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/permissions.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

const COLLECTION = `test_perms_${Date.now()}`;
let db: Database;

let godCookie: string;
let adminCookie: string;
let employeeCookie: string;

let godUserId: string;
let adminUserId: string;
let employeeUserId: string;

let checkPermission: typeof import('../../lib/permissions.js').checkPermission;
let initPermissions: typeof import('../../lib/permissions.js').initPermissions;
let invalidateUserPermCache: typeof import('../../lib/permissions.js').invalidateUserPermCache;
let getEnforcer: typeof import('../../lib/permissions.js').getEnforcer;

async function signUp(email: string, password: string, name: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  const body = await res.json();
  return body.user?.id ?? body.id;
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

beforeAll(async () => {
  if (skipAll) return;

  process.env.DATABASE_URL = TEST_DB_URL!;
  const { initDatabase } = await import('../../db/index.js');
  db = await initDatabase();

  const perms = await import('../../lib/permissions.js');
  checkPermission = perms.checkPermission;
  initPermissions = perms.initPermissions;
  invalidateUserPermCache = perms.invalidateUserPermCache;
  getEnforcer = perms.getEnforcer;
  await initPermissions(db);

  const ts = Date.now();
  const pass = 'TestPass123!';

  // Create 3 users
  godUserId = await signUp(`god-${ts}@test.local`, pass, 'God User');
  adminUserId = await signUp(`admin-${ts}@test.local`, pass, 'Admin User');
  employeeUserId = await signUp(`emp-${ts}@test.local`, pass, 'Employee User');

  // Set roles
  await sql`UPDATE "user" SET role = 'god' WHERE id = ${godUserId}`.execute(db);
  await sql`UPDATE "user" SET role = 'admin' WHERE id = ${adminUserId}`.execute(db);
  await sql`UPDATE "user" SET role = 'employee' WHERE id = ${employeeUserId}`.execute(db);

  // Sign in all
  godCookie = await signIn(`god-${ts}@test.local`, pass);
  adminCookie = await signIn(`admin-${ts}@test.local`, pass);
  employeeCookie = await signIn(`emp-${ts}@test.local`, pass);

  // Create test collection
  await fetch(`${BASE_URL}/api/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: godCookie },
    body: JSON.stringify({
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text' }],
    }),
  });
}, 30_000);

afterAll(async () => {
  if (skipAll || !db) return;

  // Cleanup Casbin policies for employee
  if (employeeUserId) {
    const enforcer = await getEnforcer();
    await enforcer.removeFilteredPolicy(0, employeeUserId).catch(() => {});
  }

  // Drop test collection
  await fetch(`${BASE_URL}/api/collections/${COLLECTION}`, {
    method: 'DELETE',
    headers: { Cookie: godCookie },
  }).catch(() => {});

  // Delete test users
  for (const id of [godUserId, adminUserId, employeeUserId].filter(Boolean)) {
    await sql`DELETE FROM "user" WHERE id = ${id}`.execute(db).catch(() => {});
  }

  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('Permissions — Integration', () => {
  it('god user can access any collection (Emergency Admin bypass)', async () => {
    await invalidateUserPermCache(godUserId);
    const result = await checkPermission(godUserId, COLLECTION, 'read');
    expect(result).toBe(true);
  });

  it('admin user can access collections with Casbin policy', async () => {
    const enforcer = await getEnforcer();
    await enforcer.addPolicy(adminUserId, COLLECTION, 'read');
    await invalidateUserPermCache(adminUserId);

    const result = await checkPermission(adminUserId, COLLECTION, 'read');
    expect(result).toBe(true);

    // Cleanup
    await enforcer.removePolicy(adminUserId, COLLECTION, 'read');
  });

  it('employee cannot access collection without policy', async () => {
    await invalidateUserPermCache(employeeUserId);
    const result = await checkPermission(employeeUserId, COLLECTION, 'read');
    expect(result).toBe(false);
  });

  it('employee can read after adding Casbin policy', async () => {
    const enforcer = await getEnforcer();
    await enforcer.addPolicy(employeeUserId, COLLECTION, 'read');
    await invalidateUserPermCache(employeeUserId);

    const result = await checkPermission(employeeUserId, COLLECTION, 'read');
    expect(result).toBe(true);
  });

  it('employee still cannot write even with read policy', async () => {
    await invalidateUserPermCache(employeeUserId);
    const result = await checkPermission(employeeUserId, COLLECTION, 'write');
    expect(result).toBe(false);
  });

  it('employee loses read access after policy removal', async () => {
    const enforcer = await getEnforcer();
    await enforcer.removePolicy(employeeUserId, COLLECTION, 'read');
    await invalidateUserPermCache(employeeUserId);

    const result = await checkPermission(employeeUserId, COLLECTION, 'read');
    expect(result).toBe(false);
  });

  it('cache invalidation reflects permission changes immediately', async () => {
    const enforcer = await getEnforcer();

    // Add policy — must be visible after invalidation
    await enforcer.addPolicy(employeeUserId, COLLECTION, 'delete');
    await invalidateUserPermCache(employeeUserId);
    const after = await checkPermission(employeeUserId, COLLECTION, 'delete');
    expect(after).toBe(true);

    // Remove policy — must be invisible after invalidation
    await enforcer.removePolicy(employeeUserId, COLLECTION, 'delete');
    await invalidateUserPermCache(employeeUserId);
    const afterRemove = await checkPermission(employeeUserId, COLLECTION, 'delete');
    expect(afterRemove).toBe(false);
  });
});
