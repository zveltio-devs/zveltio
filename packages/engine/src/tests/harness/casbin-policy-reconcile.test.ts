/**
 * The bus is lossy; the table is not. An instance that missed a policy message
 * must still converge on `zvd_permissions`.
 *
 * The realtime bus drops what is published while a subscriber is away (a Valkey
 * reconnect, a lost NOTIFY). Before `reconcilePolicies` an instance that missed a
 * REVOKE kept honouring it until the next change to the same rules or a restart.
 * Each test here changes the table behind the enforcer's back, exactly what a
 * missed message looks like from the receiving side, and runs one reconcile tick.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { realtimeBus, type RealtimeBusMessage } from '../../lib/runtime/index.js';
import {
  checkPermission,
  clearLocalPermissionCache,
  getEnforcer,
  invalidateAllPermissionCaches,
  materializeDefaultGrants,
  reconcilePolicies,
} from '../../lib/tenancy/index.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';
import {
  _wsPermCacheForTests,
  broadcastEvent,
  revalidateWsSubscriptions,
} from '../../routes/ws.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

d('policy reconcile', () => {
  let db: Database;
  const sent: Array<Omit<RealtimeBusMessage, 'originId'>> = [];
  const bus = realtimeBus();
  const origPublish = bus.publish;

  const check = (user: string, resource: string) =>
    runWithDomain(TENANT, () => checkPermission(user, resource, 'read'));

  /** A rule written or removed by "another instance" whose message never arrived. */
  const insertRow = (rule: string[]) =>
    sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
        VALUES ('p', ${rule[0]}, ${rule[1]}, ${rule[2]}, ${rule[3]})`.execute(db);
  const deleteRow = (rule: string[]) =>
    sql`DELETE FROM zvd_permissions WHERE ptype = 'p' AND v0 = ${rule[0]} AND v1 = ${rule[1]}
          AND v2 = ${rule[2]} AND v3 = ${rule[3]}`.execute(db);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    bus.publish = async (payload) => {
      sent.push(payload);
    };
    // Whatever earlier suites left behind, start from a settled enforcer.
    await reconcilePolicies();
  });

  afterAll(async () => {
    bus.publish = origPublish;
    await sql`DELETE FROM zvd_permissions WHERE v0 LIKE ${`%${tag}%`} OR v2 LIKE ${`%${tag}%`}`.execute(
      db,
    );
    await reconcilePolicies();
    clearLocalPermissionCache();
  });

  it('a revoke whose message was lost stops being honoured at the next tick', async () => {
    const e = await getEnforcer();
    const user = `rc-u1-${tag}`;
    const role = `rc_role1_${tag}`;
    const rule = [role, '*', `rc_res1_${tag}`, 'read'];
    await e.addRoleForUser(user, role, TENANT);
    await e.addPolicy(...rule);
    await reconcilePolicies();
    expect(await check(user, rule[2]!)).toBe(true);

    await deleteRow(rule);
    expect(await check(user, rule[2]!)).toBe(true); // stale, as a replica that missed it

    expect(await reconcilePolicies()).toBe(true);
    expect(await check(user, rule[2]!)).toBe(false);
    expect((await getEnforcer()).getModel().hasPolicy('p', 'p', rule)).toBe(false);
  });

  it('a grant whose message was lost arrives at the next tick', async () => {
    const e = await getEnforcer();
    const user = `rc-u2-${tag}`;
    const role = `rc_role2_${tag}`;
    const rule = [role, '*', `rc_res2_${tag}`, 'read'];
    await e.addRoleForUser(user, role, TENANT);
    await reconcilePolicies();

    await insertRow(rule);
    expect(await check(user, rule[2]!)).toBe(false);

    expect(await reconcilePolicies()).toBe(true);
    expect(await check(user, rule[2]!)).toBe(true);
  });

  it('a tick after a change the bus did deliver rebuilds nothing', async () => {
    const e = await getEnforcer();
    await reconcilePolicies();
    await e.addPolicy(`rc_role3_${tag}`, '*', `rc_res3_${tag}`, 'read'); // table and model agree
    expect(await reconcilePolicies()).toBe(false);
    expect(await getEnforcer()).toBe(e);
  });

  it('a tick with nothing changed rebuilds nothing', async () => {
    await reconcilePolicies();
    const before = await getEnforcer();
    expect(await reconcilePolicies()).toBe(false);
    expect(await getEnforcer()).toBe(before);
  });

  it('a check that straddles the swap does not cache the pre-swap answer', async () => {
    const e = await getEnforcer();
    const user = `rc-u4-${tag}`;
    const role = `rc_role4_${tag}`;
    const rule = [role, '*', `rc_res4_${tag}`, 'read'];
    await e.addRoleForUser(user, role, TENANT);
    await e.addPolicy(...rule);
    await reconcilePolicies();
    clearLocalPermissionCache();

    // The tick lands while the check is between reading roles and policies.
    const live = await getEnforcer();
    const orig = live.getImplicitRolesForUser.bind(live);
    live.getImplicitRolesForUser = async (...args: Parameters<typeof orig>) => {
      const roles = await orig(...args);
      await deleteRow(rule);
      expect(await reconcilePolicies()).toBe(true);
      return roles;
    };
    try {
      await check(user, rule[2]!); // either answer is right for THIS request
    } finally {
      live.getImplicitRolesForUser = orig;
    }
    expect(await check(user, rule[2]!)).toBe(false);
  });

  it('a local write that overlaps a rebuild is not swapped away', async () => {
    const e = await getEnforcer();
    const user = `rc-u5-${tag}`;
    const role = `rc_role5_${tag}`;
    const rule = [role, '*', `rc_res5_${tag}`, 'read'];
    await e.addRoleForUser(user, role, TENANT);
    await e.addPolicy(...rule);
    await reconcilePolicies();
    expect(await check(user, rule[2]!)).toBe(true); // also warms the god memo

    // Something for the tick to rebuild for: a grant whose message was lost.
    await insertRow([`rc_other5_${tag}`, '*', `rc_res5b_${tag}`, 'read']);

    // Hold the row, so the revoke below is in flight for the whole tick.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const lock = db.transaction().execute(async (trx) => {
      await sql`SELECT 1 FROM zvd_permissions WHERE ptype = 'p' AND v0 = ${role} FOR UPDATE`.execute(
        trx,
      );
      locked();
      await held;
    });
    await isLocked;

    // An admin request, on the enforcer it fetched — the live one.
    const revoke = (await getEnforcer()).removePolicy(...rule);
    await reconcilePolicies();
    release();
    await lock;
    await revoke;

    // Answered before any follow-up reconcile could run: the live enforcer must
    // be the one the revoke went to.
    expect(await check(user, rule[2]!)).toBe(false);
    expect(await reconcilePolicies()).toBe(true);
    expect(await check(user, rule[2]!)).toBe(false);
  });

  it('refuses a transaction handle rather than announce grants before they commit', async () => {
    const res = `rc_trx_${tag}`;
    sent.length = 0;
    await db
      .transaction()
      .execute(async (trx) => {
        await expect(materializeDefaultGrants(trx, [res])).rejects.toThrow(
          /not inside a transaction/,
        );
        throw new Error('rollback');
      })
      .catch(() => {});
    expect(sent).toHaveLength(0);
    expect((await getEnforcer()).getModel().getFilteredPolicy('p', 'p', 2, res)).toHaveLength(0);
  });

  it('an open WebSocket subscription ends when its read is revoked', async () => {
    const e = await getEnforcer();
    const user = `rc-u7-${tag}`;
    const role = `rc_role7_${tag}`;
    const res = `rc_res7_${tag}`;
    const kept = `rc_res7k_${tag}`;
    await e.addRoleForUser(user, role, TENANT);
    await e.addPolicy(role, '*', res, 'read');
    await e.addPolicy(role, '*', kept, 'read');

    const { connections, indexSubscription } = _wsPermCacheForTests();
    const frames: string[] = [];
    const connId = `rc-ws-${tag}`;
    connections.set(connId, {
      userId: user,
      user: { id: user, role: 'member' } as never,
      tenantId: TENANT,
      ws: { send: (f: string) => frames.push(f) },
      subscriptions: new Set([res, `${res}:insert`, kept]),
      connectedAt: Date.now(),
      authType: 'session',
      access: new Map([
        [res, { rls: [], columns: null }],
        [kept, { rls: [], columns: null }],
      ]),
    });
    for (const ch of [res, `${res}:insert`, kept]) indexSubscription(ch, connId);
    try {
      broadcastEvent(res, 'insert', { id: 'before' }, TENANT);
      expect(frames.join('')).toContain('"before"');

      // DELETE /policies: the rule, then the route's invalidation.
      await e.removePolicy(role, '*', res, 'read');
      await invalidateAllPermissionCaches();
      await revalidateWsSubscriptions();

      const conn = connections.get(connId)!;
      expect([...conn.subscriptions]).toEqual([kept]);
      expect(frames.some((f) => f.includes('"unsubscribed"') && f.includes(res))).toBe(true);
      frames.length = 0;
      broadcastEvent(res, 'insert', { id: 'after' }, TENANT);
      broadcastEvent(kept, 'insert', { id: 'still' }, TENANT);
      expect(frames.join('')).not.toContain('"after"');
      expect(frames.join('')).toContain('"still"');
    } finally {
      connections.delete(connId);
    }
  });
});
