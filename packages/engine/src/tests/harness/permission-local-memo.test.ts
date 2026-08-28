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

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  checkPermission,
  __localPermissionCacheSize,
  clearLocalPermissionCache,
  getCurrentDomain,
  getEnforcer,
  invalidateUserPermCache,
} from '../../lib/tenancy/index.js';
import { getCache } from '../../lib/runtime/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();

d('permission memo (in-process, no shared cache)', () => {
  let db: Database;
  let userId: string;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const u = await sql<{ id: string }>`SELECT id FROM "user" LIMIT 1`.execute(db);
    userId = u.rows[0]!.id;
  });

  afterEach(() => {
    clearLocalPermissionCache();
  });

  it('only engages when there is no shared cache', () => {
    // The whole safety argument rests on this: with Valkey the engine may run
    // several instances, and a per-process memo would answer from one that
    // never saw the revocation. Without it the engine is single-instance, so
    // in-process invalidation is complete invalidation.
    expect(getCache()).toBeNull();
  });

  it('answers a repeated check from the memo, and answers it the same', async () => {
    const first = await checkPermission(userId, `memo_${STAMP}`, 'read');

    const t = performance.now();
    const second = await checkPermission(userId, `memo_${STAMP}`, 'read');
    const elapsed = performance.now() - t;

    expect(second).toBe(first);
    // The uncached call is ~370ms on this dataset; anything under 50ms cannot
    // have gone through `enforce()`. Deliberately loose — this asserts "was
    // memoized", not a benchmark that would flake on a loaded machine.
    expect(elapsed).toBeLessThan(50);
  });

  it('a full clear sends the next check back through the enforcer', async () => {
    await checkPermission(userId, `clear_${STAMP}`, 'read');
    clearLocalPermissionCache();

    const t = performance.now();
    await checkPermission(userId, `clear_${STAMP}`, 'read');
    expect(performance.now() - t).toBeGreaterThan(50);
  });

  it('clearing one user leaves another user memoized', async () => {
    const other = `not-a-real-user-${STAMP}`;
    await checkPermission(userId, `scoped_${STAMP}`, 'read');
    await checkPermission(other, `scoped_${STAMP}`, 'read');

    clearLocalPermissionCache(userId);

    const tOther = performance.now();
    await checkPermission(other, `scoped_${STAMP}`, 'read');
    expect(performance.now() - tOther).toBeLessThan(50);

    const tMine = performance.now();
    await checkPermission(userId, `scoped_${STAMP}`, 'read');
    expect(performance.now() - tMine).toBeGreaterThan(50);
  });

  it('invalidateUserPermCache drops the memo even with no shared cache', async () => {
    // This is the one that turns a memo into a security bug if it regresses:
    // the function used to return early when `getCache()` was null, which would
    // leave a revoked grant answering from memory until its TTL ran out.
    await checkPermission(userId, `revoke_${STAMP}`, 'read');

    await invalidateUserPermCache(userId);

    const t = performance.now();
    await checkPermission(userId, `revoke_${STAMP}`, 'read');
    expect(performance.now() - t).toBeGreaterThan(50);
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

  it('keeps its bookkeeping straight — entries land, and clearing empties it', async () => {
    // The 10 000-entry cap cannot be filled honestly in a test: every miss is an
    // uncached `enforce()` at ~370 ms. What is checkable cheaply is that the map
    // is actually managed — entries are recorded, and a clear really empties it.
    clearLocalPermissionCache();
    expect(__localPermissionCacheSize()).toBe(0);

    await checkPermission(userId, `bound_${STAMP}_a`, 'read');
    await checkPermission(userId, `bound_${STAMP}_b`, 'read');
    expect(__localPermissionCacheSize()).toBe(2);

    // A repeat must be served from the memo, not stored a second time.
    await checkPermission(userId, `bound_${STAMP}_a`, 'read');
    expect(__localPermissionCacheSize()).toBe(2);

    clearLocalPermissionCache();
    expect(__localPermissionCacheSize()).toBe(0);
  });
});
