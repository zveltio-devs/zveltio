/**
 * A cached roles entry must not verify under another tenant's key.
 *
 * These entries live under two keys — `roles:<domain>:<user>` and
 * `urole:<user>` — and the HMAC used to cover only the user and the JSON, not
 * the key. So a value this engine wrote for one key verified under any other.
 * The user id is bound, so a value never crossed between people; it crossed
 * between TENANTS, which is the boundary the product is built on.
 *
 * The threat model is the one the HMACs were added for and is written at their
 * definition: an attacker who can write keys into Valkey. Copying a user's
 * `roles:<tenantA>:<user>` entry to `roles:<tenantB>:<user>` carried their
 * tenant-A roles into tenant B, signed and accepted.
 *
 * Skipped without TEST_VALKEY_URL/VALKEY_URL or TEST_DATABASE_URL — the defect only exists where
 * a shared cache does, and a green run without one would measure nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import Redis from 'ioredis';
import { sql } from 'kysely';
import { getTestApp } from '../../testing/app-harness.js';
import { initCache, getCache } from '../../lib/runtime/index.js';
import { getEnforcer, getUserRoles, runWithDomain } from '../../lib/tenancy/index.js';
import { __cacheNamespace } from '../../lib/tenancy/permissions.js';

// CI exports TEST_VALKEY_URL; with VALKEY_URL alone these skipped there.
const VALKEY_URL = process.env.TEST_VALKEY_URL ?? process.env.VALKEY_URL;
const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!VALKEY_URL || !DB_URL)('roles cache is bound to its key', () => {
  let db: any;
  const probe = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: 1, lazyConnect: true });
  const USER = `roles-bind-${crypto.randomUUID()}`;
  const TENANT_A = `tenant-a-${crypto.randomUUID()}`;
  const TENANT_B = `tenant-b-${crypto.randomUUID()}`;
  // Keys carry the instance's cache namespace since #652. This test ran only
  // with VALKEY_URL, which CI never set, so it kept probing the old key shape
  // and failed the moment it did run.
  const key = (tenant: string) => `roles:${__cacheNamespace()}:${tenant}:${USER}`;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    // The harness deletes VALKEY_URL on purpose, so the realtime bus does not
    // dial a stray one. Put it back afterwards: without a cache `getUserRoles`
    // never writes the entry this test is about, and the test would pass by
    // measuring nothing.
    process.env.VALKEY_URL = VALKEY_URL;
    if (!getCache()) await initCache();
    expect(getCache()).not.toBeNull();
    // The user administers tenant A and holds nothing at all in tenant B.
    await (await getEnforcer()).addRoleForUser(USER, 'tenant_owner', TENANT_A);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${USER}`.execute(db);
    await probe.del(key(TENANT_A), key(TENANT_B));
    probe.disconnect();
  });

  it("does not accept tenant A's entry under tenant B's key", async () => {
    // Warm the real entry the way a request does.
    const inA = await runWithDomain(TENANT_A, () => getUserRoles(USER));
    expect(inA).toContain('tenant_owner');

    const signed = await probe.get(key(TENANT_A));
    expect(signed).not.toBeNull();

    // The move an attacker with cache write access makes.
    await probe.set(key(TENANT_B), signed!);

    const inB = await runWithDomain(TENANT_B, () => getUserRoles(USER));
    // Rejected as unsigned-for-this-key, so the answer is recomputed from the
    // policy table — where this user holds nothing in tenant B.
    expect(inB).not.toContain('tenant_owner');
    expect(inB).toEqual([]);
  });
});
