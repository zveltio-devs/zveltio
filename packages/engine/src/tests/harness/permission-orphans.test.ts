/**
 * Casbin rows left by users deleted before migration 017's trigger, by SCIM,
 * GDPR erasure or raw SQL — no `user.deleted` audit row, so 017 could not tell
 * them from roles. `GET /api/admin/permissions/orphans` lists the candidates;
 * `POST …/prune` removes only the confirmed rows that are STILL orphans, through
 * the live enforcer (so the removal is published to the other replicas), and
 * audits each one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { realtimeBus, type RealtimeBusMessage } from '../../lib/runtime/index.js';
import { getEnforcer } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('orphaned Casbin rows (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let member: { cookie: string; userId: string };

  const tag = crypto.randomUUID().slice(0, 8);
  const TENANT = '00000000-0000-0000-0000-000000000001';
  const RES = `orphan-res-${tag}`;
  const GONE = `gone-user-${tag}`; // a user deleted by raw SQL long ago
  const FLIP = `flip-${tag}`; // an orphan that becomes a registered role before the prune
  const REGISTERED = `reg-role-${tag}`; // in zv_roles
  const PARENT = `parent-role-${tag}`; // held by a live user, not registered
  const G_ROW = ['g', GONE, 'tenant_member', TENANT] as const;
  const P_ROW = ['p', GONE, '*', RES, 'read'] as const;

  const bus = realtimeBus();
  const origPublish = bus.publish;
  const sent: Array<Omit<RealtimeBusMessage, 'originId'>> = [];

  type Orphan = { ptype: string; rule: string[]; subject: string; domain: string };
  const list = async (c = cookie) => {
    const res = await app.request('/api/admin/permissions/orphans', { headers: { cookie: c } });
    return { status: res.status, body: (await res.json()) as { orphans: Orphan[] } };
  };
  const prune = (rows: Array<{ ptype: string; rule: readonly string[] }>, c = cookie) =>
    app.request('/api/admin/permissions/orphans/prune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: c },
      body: JSON.stringify({ rows }),
    });
  const rowsOf = async (subject: string) =>
    (
      await sql<{ ptype: string }>`
        SELECT ptype FROM zvd_permissions WHERE v0 = ${subject} ORDER BY ptype
      `.execute(db)
    ).rows.map((r) => r.ptype);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    member = await createMemberSession(app, db, {
      grants: [{ collection: RES, actions: ['read'] }],
    });
    // Raw SQL, as legacy rows are: the live enforcer does not hold them until a
    // reconcile, which is what the prune has to cope with.
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3) VALUES
        ('g', ${GONE}, 'tenant_member', ${TENANT}, NULL),
        ('p', ${GONE}, '*', ${RES}, 'read'),
        ('p', ${FLIP}, '*', ${RES}, 'read'),
        ('p', ${REGISTERED}, '*', ${RES}, 'read'),
        ('p', ${PARENT}, '*', ${RES}, 'read'),
        ('g', ${member.userId}, ${PARENT}, '*', NULL),
        ('p', 'tenant_viewer', '*', ${RES}, 'read')
    `.execute(db);
    await sql`INSERT INTO zv_roles (name) VALUES (${REGISTERED})`.execute(db);
    bus.publish = async (payload) => {
      sent.push(payload);
    };
  });

  afterAll(async () => {
    bus.publish = origPublish;
    await sql`DELETE FROM zvd_permissions WHERE v0 LIKE ${`%${tag}%`} OR v1 LIKE ${`%${tag}%`} OR v2 = ${RES}`.execute(
      db,
    );
    await sql`DELETE FROM zv_roles WHERE name LIKE ${`%${tag}%`}`.execute(db);
  });

  it('401 without a session, 403 for a member', async () => {
    expect((await app.request('/api/admin/permissions/orphans')).status).toBe(401);
    expect((await list(member.cookie)).status).toBe(403);
    expect((await prune([{ ptype: 'p', rule: P_ROW.slice(1) }], member.cookie)).status).toBe(403);
    expect(await rowsOf(GONE)).toEqual(['g', 'p']);
  });

  it('lists the deleted user rows and no role, seeded role or live user', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    const mine = body.orphans.filter((o) => o.rule.some((v) => v.includes(tag)));
    expect(mine.map((o) => [o.ptype, ...o.rule]).sort()).toEqual(
      [[...G_ROW], [...P_ROW], ['p', FLIP, '*', RES, 'read']].sort(),
    );
    expect(mine.find((o) => o.ptype === 'g')?.domain).toBe(TENANT);
    const subjects = new Set(body.orphans.map((o) => o.subject));
    for (const known of [REGISTERED, PARENT, 'tenant_viewer', 'admin', member.userId]) {
      expect(subjects.has(known)).toBe(false);
    }
  });

  it('prunes only rows still orphaned, through the enforcer, with an audit row each', async () => {
    // Registered between the operator's look and the prune.
    await sql`INSERT INTO zv_roles (name) VALUES (${FLIP})`.execute(db);
    sent.length = 0;

    const res = await prune([
      { ptype: 'g', rule: G_ROW.slice(1) },
      { ptype: 'p', rule: P_ROW.slice(1) },
      { ptype: 'p', rule: [FLIP, '*', RES, 'read'] },
      { ptype: 'p', rule: [REGISTERED, '*', RES, 'read'] }, // never an orphan
    ]);
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      removed: Array<{ rule: string[] }>;
      skipped: Array<{ rule: string[] }>;
    };
    expect(out.removed.map((r) => r.rule[0])).toEqual([GONE, GONE]);
    expect(out.skipped.map((r) => r.rule[0]).sort()).toEqual([FLIP, REGISTERED].sort());

    expect(await rowsOf(GONE)).toEqual([]);
    expect(await rowsOf(FLIP)).toEqual(['p']);
    expect(await rowsOf(REGISTERED)).toEqual(['p']);
    expect(await rowsOf(PARENT)).toEqual(['p']);

    const e = await getEnforcer();
    expect(await e.getFilteredPolicy(0, GONE)).toEqual([]);
    expect(await e.getFilteredGroupingPolicy(0, GONE)).toEqual([]);

    // The watcher's publish is what reaches the other replicas; it is queued.
    for (let i = 0; i < 50 && sent.length < 2; i++) await Bun.sleep(20);
    const published = sent.flatMap((m) => (m.data as { rules?: string[][] }).rules ?? []);
    expect(published).toContainEqual([...G_ROW.slice(1)]);
    expect(published).toContainEqual([...P_ROW.slice(1)]);

    const audit = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log
       WHERE event_type = 'permission.revoked' AND resource_type = 'orphan_policy'
         AND resource_id = ${GONE}
    `.execute(db);
    expect(audit.rows[0]?.n).toBe(2);
  });
});
