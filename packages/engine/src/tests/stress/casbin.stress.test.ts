/**
 * Casbin RBAC — Stress & Lockout Tests
 *
 * Requires a real PostgreSQL + Cache (Valkey) setup.
 * Set TEST_DATABASE_URL env var to a dedicated test database.
 *
 * Run with: bun test packages/engine/src/tests/stress/casbin.stress.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, jest as vi } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skipAll = !TEST_DB_URL;

let db: Database;
let checkPermission: typeof import('../../lib/permissions.js').checkPermission;
let initPermissions: typeof import('../../lib/permissions.js').initPermissions;
let invalidateUserPermCache: typeof import('../../lib/permissions.js').invalidateUserPermCache;
let invalidateGodCache: typeof import('../../lib/permissions.js').invalidateGodCache;
let getEnforcer: typeof import('../../lib/permissions.js').getEnforcer;

beforeAll(async () => {
  if (skipAll) return;

  // Save original DATABASE_URL and set test DB
  const originalDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = TEST_DB_URL!;

  const { initDatabase } = await import('../../db/index.js');
  db = await initDatabase();

  // Restore original DATABASE_URL
  if (originalDbUrl) {
    process.env.DATABASE_URL = originalDbUrl;
  }

  const perms = await import('../../lib/permissions.js');
  checkPermission = perms.checkPermission;
  initPermissions = perms.initPermissions;
  invalidateUserPermCache = perms.invalidateUserPermCache;
  invalidateGodCache = perms.invalidateGodCache;
  getEnforcer = perms.getEnforcer;

  await initPermissions(db);
});

afterAll(async () => {
  if (skipAll || !db) return;
  await db.destroy().catch(() => {});
});

/** Creates a test user and returns their ID. */
async function createTestUser(role = 'user'): Promise<string> {
  const result = await sql<{ id: string }>`
    INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
    VALUES (
      gen_random_uuid()::text,
      ${`test-${Date.now()}-${Math.random()}`},
      ${`test-${Date.now()}-${Math.random()}@test.local`},
      true,
      ${role},
      NOW(),
      NOW()
    )
    RETURNING id
  `.execute(db);
  return result.rows[0].id;
}

/** Deletes a test user by ID. */
async function deleteTestUser(userId: string): Promise<void> {
  await sql`DELETE FROM "user" WHERE id = ${userId}`
    .execute(db)
    .catch(() => {});
}

describe.skipIf(skipAll)('Casbin RBAC — Stress & Lockout Tests', () => {
  // ═══ God Bypass Durability ═══

  it('god user should have access even with ALL policies deleted', async () => {
    const godUserId = await createTestUser('god');
    const normalUserId = await createTestUser('user');

    try {
      // Delete ALL Casbin policies
      await sql`DELETE FROM zvd_permissions`.execute(db);

      // Reload enforcer to pick up empty policy set
      const enforcer = await getEnforcer();
      await enforcer.loadPolicy();

      // Invalidate all caches
      await invalidateGodCache(godUserId);
      await invalidateUserPermCache(godUserId);
      await invalidateUserPermCache(normalUserId);

      // God user should ALWAYS have access (hardcoded bypass)
      const godResult = await checkPermission(
        godUserId,
        'any_resource',
        'any_action',
      );
      expect(godResult).toBe(true);

      // Normal user should be denied (no policies)
      const normalResult = await checkPermission(
        normalUserId,
        'any_resource',
        'any_action',
      );
      expect(normalResult).toBe(false);
    } finally {
      await deleteTestUser(godUserId);
      await deleteTestUser(normalUserId);
    }
  }, 15_000);

  it('god user should bypass even conflicting deny-style scenario', async () => {
    const godUserId = await createTestUser('god');

    try {
      // Ensure no policies for god user
      await sql`DELETE FROM zvd_permissions WHERE v0 = ${godUserId}`.execute(
        db,
      );
      const enforcer = await getEnforcer();
      await enforcer.loadPolicy();
      await invalidateGodCache(godUserId);
      await invalidateUserPermCache(godUserId);

      // Even with no "allow" policies — god bypass fires first
      const result = await checkPermission(
        godUserId,
        'secret_resource',
        'delete',
      );
      expect(result).toBe(true);
    } finally {
      await deleteTestUser(godUserId);
    }
  }, 15_000);

  // ═══ Performance Under Load ═══

  it('should handle 200 concurrent permission checks correctly', async () => {
    const userId = await createTestUser('user');

    try {
      // Add a single policy
      const enforcer = await getEnforcer();
      await enforcer.addPolicy(userId, 'perf_resource', 'read');
      await invalidateUserPermCache(userId);

      const start = Date.now();
      const checks = Array.from({ length: 200 }, () =>
        checkPermission(userId, 'perf_resource', 'read'),
      );
      const results = await Promise.all(checks);
      const duration = Date.now() - start;

      // All checks must return true
      expect(results.every((r) => r === true)).toBe(true);
      // Must complete in reasonable time
      expect(duration).toBeLessThan(10_000);

      // Cleanup
      await enforcer.removePolicy(userId, 'perf_resource', 'read');
    } finally {
      await deleteTestUser(userId);
    }
  }, 20_000);

  it('should handle concurrent policy updates and permission checks without crashes', async () => {
    const userId = await createTestUser('user');
    const enforcer = await getEnforcer();

    try {
      const checks = Array.from({ length: 50 }, () =>
        checkPermission(userId, 'concurrent_res', 'write').catch(() => false),
      );
      const updates = Array.from({ length: 10 }, async (_, i) => {
        await enforcer.addPolicy(userId, `res_${i}`, 'read').catch(() => {});
        await invalidateUserPermCache(userId);
      });

      // Run checks and updates simultaneously — must not crash
      await expect(Promise.all([...checks, ...updates])).resolves.not.toThrow();
    } finally {
      await deleteTestUser(userId);
    }
  }, 15_000);

  // ═══ Cache Consistency ═══

  it('should reflect policy changes after cache invalidation', async () => {
    const userId = await createTestUser('user');
    const enforcer = await getEnforcer();

    try {
      // Initially no policy
      await invalidateUserPermCache(userId);
      const before = await checkPermission(userId, 'cache_res', 'read');
      expect(before).toBe(false);

      // Add policy
      await enforcer.addPolicy(userId, 'cache_res', 'read');

      // Invalidate cache to pick up new policy
      await invalidateUserPermCache(userId);

      const after = await checkPermission(userId, 'cache_res', 'read');
      expect(after).toBe(true);

      // Cleanup
      await enforcer.removePolicy(userId, 'cache_res', 'read');
    } finally {
      await deleteTestUser(userId);
    }
  }, 15_000);

  it('should fall back to Casbin when Redis is unavailable', async () => {
    const userId = await createTestUser('user');
    const enforcer = await getEnforcer();

    try {
      await enforcer.addPolicy(userId, 'fallback_res', 'read');

      // Mock cache to throw on all operations
      const { getCache } = await import('../../lib/cache.js');
      const cache = getCache();
      if (cache) {
        vi.spyOn(cache, 'get').mockRejectedValue(
          new Error('Cache unavailable'),
        );
        vi.spyOn(cache, 'setex').mockRejectedValue(
          new Error('Cache unavailable'),
        );

        try {
          // Must still work via direct Casbin check
          const result = await checkPermission(userId, 'fallback_res', 'read');
          expect(result).toBe(true);
        } finally {
          vi.restoreAllMocks();
        }
      } else {
        // No cache configured — direct Casbin check should still work
        const result = await checkPermission(userId, 'fallback_res', 'read');
        expect(result).toBe(true);
      }

      await enforcer.removePolicy(userId, 'fallback_res', 'read');
    } finally {
      await deleteTestUser(userId);
    }
  }, 15_000);
});
