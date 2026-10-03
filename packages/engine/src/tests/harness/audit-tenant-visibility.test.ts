/**
 * A tenant sees the audit events that act on it, and only those.
 *
 * After migration 040 a row's tenant was whatever transaction wrote it.
 * `/api/tenants` runs in none, so god adding someone to a firm, removing them,
 * or archiving the firm was an instance row the firm never saw; an accepted
 * invitation wrote no row at all. The other way round, global settings, role
 * definitions and extension lifecycle are written inside the request's tenant
 * transaction, so the firm the request resolved (the default one, on the root
 * host) read the instance's administration as its own activity.
 *
 * Also the extension surface over it: `readAuditActivity` needs `audit:read`,
 * `countAuditActivity` (a number) does not.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites, auditLog, type AuditEventType } from '../../lib/audit.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionInternals } from '../../lib/extensions/internals.js';
import { hashInvitationToken } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID, runWithDomain, withTenantIsolation } from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const TAG = `audvis-${A.slice(0, 8)}`;
const MEMBER_EMAIL = `${TAG}-member@test.local`;
const INVITEE = `${TAG}-invitee@test.local`;
const TOKEN = `${TAG}-${crypto.randomUUID()}-token-padding`;

d('audit events reach the tenant they act on', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let memberId: string;
  let inviteeId = '';
  let reader: ExtensionInternals;
  const h = () => ({ 'Content-Type': 'application/json', cookie });
  const settle = async (res: Response) => {
    await _settleAuditWrites();
    return res;
  };
  // From this file's start: the default tenant's trail outlives every run.
  const START = new Date();
  const activity = (tenant: string, eventType: string) =>
    runWithDomain(tenant, () => reader.readAuditActivity({ eventType, limit: 100, since: START }));
  const tenantOf = async (eventType: string, resourceId: string) =>
    (
      await sql<{ tenant_id: string | null }>`
        SELECT tenant_id::text AS tenant_id FROM zv_audit_log
         WHERE event_type = ${eventType} AND resource_id = ${resourceId}
         ORDER BY created_at DESC LIMIT 1`.execute(db)
    ).rows.map((r) => r.tenant_id);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    for (const id of [A, B]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}::uuid, ${`${TAG}-${id.slice(0, 4)}`}, ${TAG}, 'active')`.execute(db);
    }
    const signUp = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MEMBER_EMAIL, password: 'Audvis-pass-123', name: 'm' }),
    });
    expect(signUp.ok).toBe(true);
    memberId = (
      await sql<{ id: string }>`SELECT id FROM "user" WHERE email = ${MEMBER_EMAIL}`.execute(db)
    ).rows[0]!.id;
    await sql`
      INSERT INTO zv_invitations (email, name, role, token, expires_at, tenant_id)
      VALUES (${INVITEE}, 'Invitee', 'member', ${hashInvitationToken(TOKEN)},
              NOW() + INTERVAL '1 day', ${A}::uuid)`.execute(db);
    reader = gateInternals('audit-reader', buildExtensionInternals(), ['audit:read']);
  });

  afterAll(async () => {
    if (!db) return;
    await _settleAuditWrites();
    const users = [memberId, inviteeId].filter(Boolean);
    await sql`DELETE FROM zv_audit_log WHERE tenant_id IN (${A}::uuid, ${B}::uuid)
               OR event_type LIKE ${`${TAG}%`}`.execute(db);
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id IN (${A}::uuid, ${B}::uuid)`.execute(db);
    await sql`DELETE FROM zv_invitations WHERE email = ${INVITEE}`.execute(db);
    await sql`DELETE FROM casbin_rule WHERE v2 IN (${A}, ${B})`.execute(db).catch(() => {});
    for (const u of users) {
      await sql`DELETE FROM zv_audit_log WHERE user_id = ${u} OR resource_id = ${u}`.execute(db);
      await sql`DELETE FROM "session" WHERE "userId" = ${u}`.execute(db);
      await sql`DELETE FROM "account" WHERE "userId" = ${u}`.execute(db);
      await sql`DELETE FROM "user" WHERE id = ${u}`.execute(db);
    }
    await sql`DELETE FROM zv_tenants WHERE id IN (${A}::uuid, ${B}::uuid)`.execute(db);
  });

  it("god's member changes through /api/tenants show in that tenant's activity, not another's", async () => {
    const add = await settle(
      await app.request(`/api/tenants/${A}/members`, {
        method: 'POST',
        headers: h(),
        body: JSON.stringify({ user_email: MEMBER_EMAIL, role: 'member' }),
      }),
    );
    expect(add.status).toBe(201);
    const del = await settle(
      await app.request(`/api/tenants/${A}/members/${memberId}`, {
        method: 'DELETE',
        headers: h(),
      }),
    );
    expect(del.status).toBe(200);

    const added = await activity(A, 'tenant.member_added');
    expect(added.map((r) => r.resource_id)).toContain(memberId);
    const removed = await activity(A, 'tenant.member_removed');
    expect(removed.map((r) => r.resource_id)).toContain(memberId);
    expect(await tenantOf('tenant.member_added', memberId)).toEqual([A]);

    expect((await activity(B, 'tenant.member_added')).map((r) => r.resource_id)).not.toContain(
      memberId,
    );
  });

  it('archiving a tenant is that tenant’s activity', async () => {
    const res = await settle(
      await app.request(`/api/tenants/${B}?mode=archive`, { method: 'DELETE', headers: h() }),
    );
    expect(res.status).toBe(200);
    expect(await tenantOf('tenant.archived', B)).toEqual([B]);
    expect(await activity(A, 'tenant.archived')).toEqual([]);
  });

  it('an accepted invitation is a member joining the issuing tenant', async () => {
    const res = await settle(
      await app.request('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, password: 'Audvis-pass-123', name: 'Invitee' }),
      }),
    );
    expect(res.status).toBe(201);
    inviteeId = ((await res.json()) as { user: { id: string } }).user.id;
    expect((await activity(A, 'tenant.member_added')).map((r) => r.resource_id)).toContain(
      inviteeId,
    );
  });

  it('a global setting change is instance-level: no tenant reads it, the default one included', async () => {
    const key = 'app_name';
    const res = await settle(
      await app.request(`/api/settings/${key}`, {
        method: 'PUT',
        headers: h(),
        body: JSON.stringify({ value: TAG }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await tenantOf('settings.changed', key)).toEqual([null]);
    const inDefault = await activity(DEFAULT_TENANT_ID, 'settings.changed');
    expect(inDefault.map((r) => r.resource_id)).not.toContain(key);
  });

  it("god's request on a tenant's data is that tenant's; elsewhere it is the instance's", async () => {
    const slug = `${TAG}-${A.slice(0, 4)}`;
    await settle(
      await app.request(`/api/data/${TAG}_none`, { headers: { cookie, 'x-tenant-slug': slug } }),
    );
    await settle(
      await app.request('/api/settings', { headers: { cookie, 'x-tenant-slug': slug } }),
    );
    expect(await tenantOf('god_action', `/api/data/${TAG}_none`)).toEqual([A]);
    expect(await tenantOf('god_action', '/api/settings')).toEqual([null]);
  });

  it('countAuditActivity counts the running tenant’s rows only, from `since` on', async () => {
    const EV = `${TAG}.count` as AuditEventType;
    const since = new Date(Date.now() - 1000);
    await withTenantIsolation(A, async (trx) => {
      for (let i = 0; i < 3; i++) await auditLog(trx, { type: EV });
    });
    await withTenantIsolation(B, (trx) => auditLog(trx, { type: EV }));
    await auditLog(db, { type: EV, tenantId: null });
    const ungated = gateInternals('audit-counter', buildExtensionInternals(), []);
    const count = (t: string, q: { since: Date | string; eventType?: string }) =>
      runWithDomain(t, () => ungated.countAuditActivity(q));
    expect(await count(A, { since, eventType: EV })).toBe(3);
    expect(await count(B, { since, eventType: EV })).toBe(1);
    expect(await count(A, { since: new Date(Date.now() + 60_000), eventType: EV })).toBe(0);
    await expect(
      runWithDomain(A, () => ungated.countAuditActivity({} as { since: Date })),
    ).rejects.toThrow(/since is required/);
  });

  it("inside god's request transaction both helpers still answer for the running tenant only", async () => {
    // God's transaction publishes every firm as visible, so the policy lets B's
    // rows through; the helpers' own tenant filter is what keeps them out.
    const EV = `${TAG}.godreach` as AuditEventType;
    const since = new Date(Date.now() - 1000);
    await withTenantIsolation(A, (trx) => auditLog(trx, { type: EV, resourceId: 'a' }));
    await withTenantIsolation(B, (trx) => auditLog(trx, { type: EV, resourceId: 'b' }));
    const godId = (
      await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god' LIMIT 1`.execute(db)
    ).rows[0]!.id;
    const asGodIn = <T>(fn: (trx: Database) => Promise<T>) =>
      withTenantIsolation(A, fn, { userId: godId });
    // Negative control: the transaction really does reach B's row.
    const reach = await asGodIn(async (trx) =>
      sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM zv_audit_log WHERE event_type = ${EV}`
        .execute(trx)
        .then((r) => r.rows[0]!.n),
    );
    expect(reach).toBe(2);
    const ungated = gateInternals('audit-counter', buildExtensionInternals(), []);
    expect(await asGodIn(() => ungated.countAuditActivity({ since, eventType: EV }))).toBe(1);
    const rows = await asGodIn(() => reader.readAuditActivity({ eventType: EV, since }));
    expect(rows.map((r) => r.resource_id)).toEqual(['a']);
  });

  it('readAuditActivity needs audit:read', async () => {
    const without = gateInternals('audit-nocap', buildExtensionInternals(), []);
    await expect(
      runWithDomain(A, async () => without.readAuditActivity({ limit: 1 })),
    ).rejects.toThrow(/"audit:read" capability/);
    expect(Array.isArray(await activity(A, 'tenant.member_added'))).toBe(true);
  });
});
