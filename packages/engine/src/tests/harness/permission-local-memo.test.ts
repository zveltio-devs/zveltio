/**
 * `checkPermission` is one Casbin `enforce()` over every loaded policy, and on a
 * 7 208-policy instance that call was measured at 364 ms — single-threaded CPU,
 * on the request thread, with nothing memoizing it. Asking twice for the same
 * resource cost the same twice.
 *
 * The Valkey branch was the only thing standing between that and every
 * authenticated request, so an install without a cache answered a plain 401 in
 * 348 ms and served three requests a second at ANY concurrency — one free
 * account was enough to hold the engine there.
 *
 * The memo is deliberately in-process-only-when-there-is-no-shared-cache, and
 * the tests that matter most here are not the fast ones. They are the ones
 * proving a revocation is never served from it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  checkPermission,
  __effectivePermissionsSize,
  __localPermissionCacheSize,
  LOCAL_PERM_MAX,
  clearLocalPermissionCache,
  getCurrentDomain,
  getEnforcer,
  invalidateUserPermCache,
} from '../../lib/tenancy/index.js';
import { _setCacheForTests, getCache } from '../../lib/runtime/index.js';
import type Redis from 'ioredis';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();

d('permission memo (in-process, no shared cache)', () => {
  let db: Database;
  let userId: string;

  let savedCache: Redis | null = null;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    // A subject invented here, not the first row of `user`.
    //
    // `checkPermission` short-circuits on `isGodUser` before it ever reaches the
    // memo, so a fixture whose first user happens to be the god account makes
    // every assertion below fail on a cache that was never asked to hold
    // anything. Locally that row was a plain member and the tests passed; in CI
    // it was not. The memo does not care whether the subject exists — casbin
    // resolves an unknown subject to no roles, which is a perfectly good
    // "denied" — so the test does not need a real one, and a real one is exactly
    // what made it depend on the fixture.
    userId = `memo-subject-${STAMP}`;
    // The memo only engages when there is no shared cache, so the precondition
    // has to be established rather than assumed. Run alone this file already had
    // it; run as part of the suite it did not, because an earlier file leaves a
    // cache behind in the shared process — which is how these tests passed
    // locally and failed in CI.
    savedCache = getCache();
    _setCacheForTests(null);
  });

  afterAll(() => {
    _setCacheForTests(savedCache);
  });

  afterEach(() => {
    clearLocalPermissionCache();
  });

  it('only engages when there is no shared cache', () => {
    // The whole safety argument rests on this: with Valkey the engine may run
    // several instances, and a per-process memo would answer from one that
    // never saw the revocation. Without it the engine is single-instance, so
    // in-process invalidation is complete invalidation. `beforeAll` establishes
    // the condition; this states that the rest of the file depends on it.
    expect(getCache()).toBeNull();
  });

  it('answers a repeated check from the memo, and answers it the same', async () => {
    clearLocalPermissionCache();
    const first = await checkPermission(userId, `memo_${STAMP}`, 'read');
    expect(__localPermissionCacheSize()).toBe(1);

    const second = await checkPermission(userId, `memo_${STAMP}`, 'read');

    expect(second).toBe(first);
    // Deliberately not a timing assertion. Timing was the proxy while a miss
    // cost 364 ms; now that a miss is a Set lookup too, elapsed time proves
    // nothing and would flake on a loaded machine. The bookkeeping is the fact.
    expect(__localPermissionCacheSize()).toBe(1);
  });

  it('a full clear drops both the answers and the resolved subjects', async () => {
    await checkPermission(userId, `clear_${STAMP}`, 'read');
    expect(__localPermissionCacheSize()).toBeGreaterThan(0);
    expect(__effectivePermissionsSize()).toBeGreaterThan(0);

    clearLocalPermissionCache();

    expect(__localPermissionCacheSize()).toBe(0);
    expect(__effectivePermissionsSize()).toBe(0);
  });

  it('clearing one user leaves another user untouched', async () => {
    const other = `not-a-real-user-${STAMP}`;
    clearLocalPermissionCache();
    await checkPermission(userId, `scoped_${STAMP}`, 'read');
    await checkPermission(other, `scoped_${STAMP}`, 'read');
    expect(__effectivePermissionsSize()).toBe(2);

    clearLocalPermissionCache(userId);

    // One subject resolved away, the other still held.
    expect(__effectivePermissionsSize()).toBe(1);
    expect(await checkPermission(other, `scoped_${STAMP}`, 'read')).toBe(false);
  });

  it('invalidateUserPermCache drops the memo even with no shared cache', async () => {
    // This is the one that turns a memo into a security bug if it regresses:
    // the function used to return early when `getCache()` was null, which would
    // leave a revoked grant answering from memory until its TTL ran out.
    clearLocalPermissionCache();
    await checkPermission(userId, `revoke_${STAMP}`, 'read');
    expect(__localPermissionCacheSize()).toBeGreaterThan(0);
    expect(__effectivePermissionsSize()).toBeGreaterThan(0);

    await invalidateUserPermCache(userId);

    expect(__localPermissionCacheSize()).toBe(0);
    expect(__effectivePermissionsSize()).toBe(0);
  });

  it('a real grant change is visible immediately, not after a TTL', async () => {
    const resource = `grant_${STAMP}`;
    const before = await checkPermission(userId, resource, 'read');
    expect(before).toBe(false);

    const e = await getEnforcer();
    const domain = getCurrentDomain();
    await e.addPolicy(userId, domain, resource, 'read', 'allow');
    try {
      await invalidateUserPermCache(userId);
      expect(await checkPermission(userId, resource, 'read')).toBe(true);
    } finally {
      await e.removePolicy(userId, domain, resource, 'read', 'allow');
      await invalidateUserPermCache(userId);
    }
  });

  describe('names no policy mentions share one answer', () => {
    // The memo rescues a repeated question; it does nothing for a caller that
    // varies it. Measured on the live engine, `/api/data/<random>` ran at
    // 2 req/s with p50 5,5 s while a fixed name ran at 67 — every invented name
    // was a fresh 364 ms `enforce()`. The matcher compares objects with plain
    // equality, so a name no policy mentions can only be decided by the `'*'`
    // rules, and the answer cannot depend on the name. These tests pin that the
    // collapse is safe, not that it is fast.

    it('a second invented name adds no entry of its own', async () => {
      clearLocalPermissionCache();
      await checkPermission(userId, `invented_${STAMP}_1`, 'read');
      const afterFirst = __localPermissionCacheSize();

      await checkPermission(userId, `invented_${STAMP}_2`, 'read');
      expect(__localPermissionCacheSize()).toBe(afterFirst);
    });

    it('and every invented name gets the same answer', async () => {
      const a = await checkPermission(userId, `invented_${STAMP}_a`, 'read');
      const b = await checkPermission(userId, `invented_${STAMP}_b`, 'read');
      expect(b).toBe(a);
      expect(a).toBe(false);
    });

    it('naming a resource in a policy takes it out of the shared answer', async () => {
      // The one that would be a privilege bug if it regressed: a resource that
      // starts unnamed must stop sharing the collapsed answer the moment a
      // policy names it, or the grant is invisible until a TTL expires.
      const resource = `promoted_${STAMP}`;
      expect(await checkPermission(userId, resource, 'read')).toBe(false);

      const e = await getEnforcer();
      const domain = getCurrentDomain();
      await e.addPolicy(userId, domain, resource, 'read');
      try {
        expect(await checkPermission(userId, resource, 'read')).toBe(true);
        // A different invented name must NOT inherit the grant.
        expect(await checkPermission(userId, `promoted_${STAMP}_other`, 'read')).toBe(false);
      } finally {
        await e.removePolicy(userId, domain, resource, 'read');
      }
    });

    it('removing the policy puts the name back in the shared answer', async () => {
      const resource = `demoted_${STAMP}`;
      const e = await getEnforcer();
      const domain = getCurrentDomain();
      await e.addPolicy(userId, domain, resource, 'read');
      expect(await checkPermission(userId, resource, 'read')).toBe(true);

      await e.removePolicy(userId, domain, resource, 'read');
      expect(await checkPermission(userId, resource, 'read')).toBe(false);
    });
  });

  it('evicts the oldest entry rather than growing without end', async () => {
    // I called this untestable once, and was wrong for an instructive reason:
    // I assumed distinct RESOURCES, which collapse into one entry because no
    // policy names them. Distinct ACTIONS do not collapse — the action is part
    // of the key — and each one is a Set lookup against an already-resolved
    // subject, so filling the cap is seconds rather than minutes.
    clearLocalPermissionCache();
    for (let i = 0; i < LOCAL_PERM_MAX + 50; i++) {
      await checkPermission(userId, `evict_${STAMP}`, `act_${i}`);
    }
    // Bounded, not merely large: a map that only grows is a leak wearing a
    // cache's clothes.
    expect(__localPermissionCacheSize()).toBeLessThanOrEqual(LOCAL_PERM_MAX);
    expect(__localPermissionCacheSize()).toBeGreaterThan(LOCAL_PERM_MAX / 2);
  }, 120_000);

  it('bounds the resolved-subject map too', async () => {
    // The other map, keyed on (domain, subject). Unknown subjects resolve to no
    // roles, so building one is a walk over the policy list with every
    // membership test failing immediately — cheap enough to fill the cap.
    clearLocalPermissionCache();
    for (let i = 0; i < LOCAL_PERM_MAX + 50; i++) {
      await checkPermission(`bound-subject-${STAMP}-${i}`, `res_${STAMP}`, 'read');
    }
    expect(__effectivePermissionsSize()).toBeLessThanOrEqual(LOCAL_PERM_MAX);
  }, 300_000);

  it('keeps its bookkeeping straight — and invented names share one entry', async () => {
    // The 10 000-entry cap cannot be filled honestly in a test: every miss is an
    // uncached `enforce()` at ~370 ms. What is checkable cheaply is that the map
    // is managed — and that the collapse is visible in the bookkeeping itself.
    clearLocalPermissionCache();
    expect(__localPermissionCacheSize()).toBe(0);

    await checkPermission(userId, `bound_${STAMP}_a`, 'read');
    await checkPermission(userId, `bound_${STAMP}_b`, 'read');
    // Two invented names, one entry: neither is mentioned by any policy, so both
    // are the same question wearing different words.
    expect(__localPermissionCacheSize()).toBe(1);

    // A different action IS a different question.
    await checkPermission(userId, `bound_${STAMP}_c`, 'update');
    expect(__localPermissionCacheSize()).toBe(2);

    // And a resource a policy actually names gets an entry of its own.
    const e = await getEnforcer();
    const domain = getCurrentDomain();
    const named = `bound_named_${STAMP}`;
    await e.addPolicy(userId, domain, named, 'read');
    try {
      await checkPermission(userId, named, 'read');
      await checkPermission(userId, `bound_${STAMP}_d`, 'read');
      expect(__localPermissionCacheSize()).toBe(2);
    } finally {
      await e.removePolicy(userId, domain, named, 'read');
    }

    clearLocalPermissionCache();
    expect(__localPermissionCacheSize()).toBe(0);
  });
});
