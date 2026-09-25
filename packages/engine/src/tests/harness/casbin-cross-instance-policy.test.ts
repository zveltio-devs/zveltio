/**
 * A policy change on one engine instance must reach every other instance.
 *
 * Casbin keeps its policies in memory, loaded once at boot. Every write — the
 * admin permission routes, role assignment, tenant membership, the default
 * grants `materializeDefaultGrants` writes when a collection or extension
 * appears — reached the database and the memory of the instance that ran it,
 * and nothing else. A second replica kept answering from what it loaded at
 * boot, until it restarted:
 *
 *   - a REVOKED grant kept being honoured on the other replicas (fail-open —
 *     the shared Valkey cache was purged, and the stale replica simply wrote
 *     its stale `1` back into it on the next check);
 *   - a collection created on A answered 403 to ordinary users on B.
 *
 * Each test plays both replicas in one process: the real write runs on the
 * real enforcer (instance A) with the bus publish captured, then the local
 * model is put back the way a replica that never heard about it would still
 * hold it (instance B), and the captured messages are delivered through
 * `dispatchToWs` exactly as the Valkey / pg_notify subscriber does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type Redis from 'ioredis';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  _setCacheForTests,
  dispatchToWs,
  getCache,
  realtimeBus,
  type RealtimeBusMessage,
} from '../../lib/runtime/index.js';
import {
  checkPermission,
  clearLocalPermissionCache,
  getEnforcer,
  materializeDefaultGrants,
} from '../../lib/tenancy/index.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let scans = 0;

/** Just enough of ioredis for the permission cache, shared like Valkey is. */
function fakeValkey(): Redis {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const fake = {
    get: async (k: string) => kv.get(k) ?? null,
    setex: async (k: string, _ttl: number, v: string) => {
      kv.set(k, v);
      return 'OK';
    },
    sadd: async (k: string, ...members: string[]) => {
      const s = sets.get(k) ?? new Set<string>();
      for (const m of members) s.add(m);
      sets.set(k, s);
      return members.length;
    },
    expire: async () => 1,
    smembers: async (k: string) => [...(sets.get(k) ?? [])],
    del: async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) n += Number(kv.delete(k)) + Number(sets.delete(k));
      return n;
    },
    scan: async (_cursor: string, _match: string, pattern: string) => {
      scans++;
      const prefix = pattern.replace(/\*$/, '');
      return ['0', [...kv.keys(), ...sets.keys()].filter((k) => k.startsWith(prefix))];
    },
  };
  return fake as unknown as Redis;
}

d('policy changes cross instances', () => {
  let db: Database;
  let savedCache: Redis | null = null;
  const sent: Array<Omit<RealtimeBusMessage, 'originId'>> = [];
  const bus = realtimeBus();
  const origPublish = bus.publish;

  const check = (user: string, resource: string) =>
    runWithDomain(TENANT, () => checkPermission(user, resource, 'read'));

  /** Instance B receives what instance A published. */
  async function deliverToReplica(): Promise<void> {
    const batch = sent.splice(0);
    for (const m of batch) await dispatchToWs({ ...m, originId: 'replica-a' });
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    savedCache = getCache();
    _setCacheForTests(null);
    bus.publish = async (payload) => {
      sent.push(payload);
    };
  });

  afterAll(async () => {
    bus.publish = origPublish;
    _setCacheForTests(savedCache);
    await sql`DELETE FROM zvd_permissions WHERE v0 LIKE ${`%${tag}%`} OR v2 LIKE ${`%${tag}%`}`.execute(
      db,
    );
    // Rules the tests put back into memory only, as a stale replica holds them.
    const e = await getEnforcer();
    const model = e.getModel();
    for (const sec of ['p', 'g'] as const) {
      for (const rule of model.getPolicy(sec, sec)) {
        if (rule.some((v) => v.includes(tag))) await e.selfRemovePolicy(sec, sec, rule);
      }
    }
    clearLocalPermissionCache();
  });

  it('a revoked grant stops being honoured on the other replica', async () => {
    const e = await getEnforcer();
    const user = `xi-u1-${tag}`;
    const role = `xi_role1_${tag}`;
    const rule = [role, '*', `xi_res1_${tag}`, 'read'];
    await e.addRoleForUser(user, role, TENANT);
    await e.addPolicy(...rule);
    sent.length = 0;

    // Instance A: the admin DELETE /policies call.
    await e.removePolicy(...rule);

    // Instance B never saw it and still holds the rule.
    e.getModel().addPolicy('p', 'p', rule);
    clearLocalPermissionCache();
    expect(await check(user, rule[2]!)).toBe(true);

    await deliverToReplica();
    expect(await check(user, rule[2]!)).toBe(false);
    expect(e.getModel().hasPolicy('p', 'p', rule)).toBe(false);
  });

  it('a removed role assignment stops being honoured on the other replica', async () => {
    const e = await getEnforcer();
    const user = `xi-u2-${tag}`;
    const role = `xi_role2_${tag}`;
    const res = `xi_res2_${tag}`;
    await e.addPolicy(role, '*', res, 'read');
    await e.addRoleForUser(user, role, TENANT);
    sent.length = 0;

    // Instance A: the tenant member removal / role change call.
    await e.deleteRoleForUser(user, role, TENANT);

    // Instance B still holds the link — in the model AND in the role manager.
    await e.selfAddPolicy('g', 'g', [user, role, TENANT]);
    clearLocalPermissionCache();
    expect(await check(user, res)).toBe(true);

    await deliverToReplica();
    expect(await check(user, res)).toBe(false);
    expect(await e.getImplicitRolesForUser(user, TENANT)).not.toContain(role);
  });

  it('a filtered removal (bulk permission replace) reaches the other replica', async () => {
    const e = await getEnforcer();
    const user = `xi-u3-${tag}`;
    const role = `xi_role3_${tag}`;
    const rules = [
      [role, '*', `xi_res3a_${tag}`, 'read'],
      [role, '*', `xi_res3b_${tag}`, 'read'],
    ];
    await e.addRoleForUser(user, role, TENANT);
    for (const r of rules) await e.addPolicy(...r);
    sent.length = 0;

    // Instance A: POST /permissions/bulk starts with this for every custom role.
    await e.deletePermissionsForUser(role);

    for (const r of rules) e.getModel().addPolicy('p', 'p', r);
    clearLocalPermissionCache();
    expect(await check(user, rules[0]![2]!)).toBe(true);

    await deliverToReplica();
    for (const r of rules) expect(await check(user, r[2]!)).toBe(false);
  });

  it('a new default grant reaches the other replica without a restart', async () => {
    const e = await getEnforcer();
    const member = `xi-u4-${tag}`;
    const res = `xi_new_${tag}`;
    await e.addRoleForUser(member, 'tenant_member', TENANT);
    sent.length = 0;

    // Instance A: a collection is created.
    expect(await materializeDefaultGrants(db, [res])).toBe(4);

    // Instance B loaded its policies before the collection existed.
    for (const r of e.getModel().getFilteredPolicy('p', 'p', 2, res)) {
      e.getModel().removePolicy('p', 'p', r);
    }
    clearLocalPermissionCache();
    expect(await check(member, res)).toBe(false);

    await deliverToReplica();
    expect(await check(member, res)).toBe(true);
  });

  it('a forged message cannot grant anything the database does not hold', async () => {
    // The Valkey channel is writable by anyone who can write the cache, which is
    // the threat the cache HMACs exist for. The message is only a hint: the
    // receiver re-reads the rules it names from the database.
    const e = await getEnforcer();
    const user = `xi-u5-${tag}`;
    const res = `xi_res5_${tag}`;
    await dispatchToWs({
      originId: 'attacker',
      event: 'casbin.policy',
      collection: '',
      data: { sec: 'p', ptype: 'p', rules: [[user, '*', res, 'read']] },
      timestamp: new Date().toISOString(),
    });
    expect(e.getModel().hasPolicy('p', 'p', [user, '*', res, 'read'])).toBe(false);
    expect(await check(user, res)).toBe(false);
  });

  it('a stale ALLOW a replica wrote to the shared cache before it heard is purged', async () => {
    _setCacheForTests(fakeValkey());
    try {
      const e = await getEnforcer();
      const user = `xi-u6-${tag}`;
      const role = `xi_role6_${tag}`;
      const rule = [role, '*', `xi_res6_${tag}`, 'read'];
      await e.addRoleForUser(user, role, TENANT);
      await e.addPolicy(...rule);
      // Still named after the revoke, so the answer keeps the same cache key.
      await e.addPolicy(`xi_other6_${tag}`, '*', rule[2]!, 'read');
      sent.length = 0;

      await e.removePolicy(...rule);

      // B answers from its stale model and writes `1` into the SHARED cache.
      e.getModel().addPolicy('p', 'p', rule);
      clearLocalPermissionCache();
      expect(await check(user, rule[2]!)).toBe(true);

      // Without a SCAN of the shared keyspace: every receiver used to walk it
      // for every change. The receiver's clear moves it to a fresh namespace,
      // so the stale `1` is simply never read again.
      scans = 0;
      await deliverToReplica();
      expect(scans).toBe(0);
      expect(await check(user, rule[2]!)).toBe(false);
    } finally {
      _setCacheForTests(null);
    }
  });

  it("a deny cached just before the resource's default grant does not outlive the grant", async () => {
    _setCacheForTests(fakeValkey());
    try {
      const e = await getEnforcer();
      const member = `xi-u7-${tag}`;
      const res = `xi_res7_${tag}`;
      await e.addRoleForUser(member, 'tenant_member', TENANT);
      // Named by some other rule, so the answer is filed under its own key.
      await e.addPolicy(`xi_other_${tag}`, '*', res, 'read');
      expect(await check(member, res)).toBe(false); // `0` now in the shared cache

      expect(await materializeDefaultGrants(db, [res])).toBe(4);
      expect(await check(member, res)).toBe(true);
    } finally {
      _setCacheForTests(null);
    }
  });

  it('an answer computed across a policy change is not memoized', async () => {
    const e = await getEnforcer();
    const user = `xi-u8-${tag}`;
    const role = `xi_role8_${tag}`;
    const res = `xi_res8_${tag}`;
    await e.addPolicy(role, '*', res, 'read');
    await e.addRoleForUser(user, role, TENANT);
    clearLocalPermissionCache();

    // The revoke lands while the check is between reading roles and policies —
    // what a replica applying a bus message does to a request in flight.
    const orig = e.getImplicitRolesForUser.bind(e);
    e.getImplicitRolesForUser = async (...args: Parameters<typeof orig>) => {
      const roles = await orig(...args);
      await e.selfRemovePolicy('g', 'g', [user, role, TENANT]);
      clearLocalPermissionCache();
      return roles;
    };
    try {
      // Started before the revoke, so allowing it is right — for this request.
      expect(await check(user, res)).toBe(true);
    } finally {
      e.getImplicitRolesForUser = orig;
    }
    expect(await check(user, res)).toBe(false);
  });
});
