/**
 * The `ctx.internals` facts that replace raw SQL on engine tables (#858).
 *
 * Extensions computed headcounts, role lists, settings and audit rows with raw
 * SQL on `"user"`, `zv_tenant_users`, `zv_tenants`, `zvd_permissions`,
 * `zv_settings` and `zv_audit_log`. #858 refused that SQL and left them no
 * other path. Each helper here is scoped by the engine to the tenant the work
 * runs as, and these cases pin that scope: another tenant's members and roles
 * are not counted or named, a non-public setting is not served, and an audit
 * row records the extension that wrote it whatever metadata it passed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { DDLManager } from '../../lib/data/index.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionInternals } from '../../lib/extensions/internals.js';
import { getEnforcer } from '../../lib/tenancy/permissions.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const TAG = `facts-${A.slice(0, 8)}`;
const ROLE_A = `${TAG}-role-a`;
const ROLE_B = `${TAG}-role-b`;
const KEY_PUBLIC = `${TAG}-public`;
const KEY_PRIVATE = `${TAG}-private`;

d('ctx.internals tenant facts', () => {
  let db: Database;
  let internals: ExtensionInternals;
  const users: string[] = [];

  const user = async (label: string) => {
    const id = `${TAG}-${label}`;
    await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
              VALUES (${id}, ${label}, ${`${id}@example.test`}, true, now(), now())`.execute(db);
    users.push(id);
    return id;
  };
  const member = (tenant: string, userId: string, role: string) =>
    sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
        VALUES (${tenant}::uuid, ${userId}, ${role})`.execute(db);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const [id, slug] of [
      [A, `${TAG}-a`],
      [B, `${TAG}-b`],
    ]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}::uuid, ${slug}, ${slug}, 'active')`.execute(db);
    }
    await member(A, await user('a-owner'), 'owner');
    await member(A, await user('a-member'), 'member');
    await member(B, await user('b-admin'), 'admin');
    await member(B, await user('b-member'), 'member');
    await member(B, await user('b-member2'), 'member');

    const e = await getEnforcer();
    await e.addRoleForUser(users[1]!, ROLE_A, A);
    await e.addRoleForUser(users[3]!, ROLE_B, B);

    await sql`INSERT INTO zv_settings (key, value, is_public) VALUES
              (${KEY_PUBLIC}, ${JSON.stringify('Acme')}::jsonb, true),
              (${KEY_PRIVATE}, ${JSON.stringify('s3cret')}::jsonb, false)`.execute(db);

    // As the loader hands it to an extension: gated, members bound to the caller.
    internals = gateInternals('facts-ext', buildExtensionInternals(), []);
  });

  afterAll(async () => {
    const e = await getEnforcer();
    await e.deleteRoleForUser(users[1]!, ROLE_A, A);
    await e.deleteRoleForUser(users[3]!, ROLE_B, B);
    await sql`DELETE FROM zvd_relations WHERE name LIKE ${`${TAG}%`}`.execute(db);
    await sql`DELETE FROM zv_settings WHERE key IN (${KEY_PUBLIC}, ${KEY_PRIVATE})`.execute(db);
    await sql`DELETE FROM zv_audit_log WHERE event_type = ${`${TAG}.event`}`.execute(db);
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id IN (${A}::uuid, ${B}::uuid)`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id IN (${A}::uuid, ${B}::uuid)`.execute(db);
    for (const id of users) await sql`DELETE FROM "user" WHERE id = ${id}`.execute(db);
  });

  it('countMembers counts the running tenant only', async () => {
    expect(await runWithDomain(A, () => internals.countMembers())).toEqual({ total: 2, admins: 1 });
    expect(await runWithDomain(B, () => internals.countMembers())).toEqual({ total: 3, admins: 1 });
  });

  it('countMembers refuses where no tenant runs', async () => {
    await expect(internals.countMembers()).rejects.toThrow(/no tenant runs here/);
  });

  it('getDataStats gives no instance-wide row estimate on a multi-tenant instance', async () => {
    const stats = await runWithDomain(A, () => internals.getDataStats());
    expect(stats.records_estimate).toBeNull();
    expect(typeof stats.collections).toBe('number');
  });

  it("listRoles names the running tenant's roles, not another tenant's", async () => {
    const inA = await runWithDomain(A, () => internals.listRoles());
    expect(inA).toContain(ROLE_A);
    expect(inA).not.toContain(ROLE_B);
    expect(inA).toContain('member');
  });

  it('getPublicSetting serves public settings only', async () => {
    expect(await internals.getPublicSetting(KEY_PUBLIC)).toBe('Acme');
    expect(await internals.getPublicSetting(KEY_PRIVATE)).toBeNull();
  });

  it('audit stamps the calling extension over whatever metadata it passed', async () => {
    await internals.audit({
      type: `${TAG}.event`,
      resourceType: 'thing',
      metadata: { extension: 'someone-else', n: 1 },
    });
    await _settleAuditWrites();
    const row = (
      await sql<{ metadata: Record<string, unknown> }>`
        SELECT metadata FROM zv_audit_log WHERE event_type = ${`${TAG}.event`}`.execute(db)
    ).rows[0];
    expect(row?.metadata).toEqual({ extension: 'ext:facts-ext', n: 1 });
  });

  // `tenantId` is not in the event's type, but the row was spread into auditLog
  // whole: an ungated extension serving A wrote into B's trail.
  it("audit writes the running tenant's row, never one a tenantId in the event names", async () => {
    const forged = { type: `${TAG}.event`, resourceType: 'forged', tenantId: B };
    await runWithDomain(A, () => internals.audit(forged));
    await internals.audit(forged);
    await _settleAuditWrites();
    const rows = (
      await sql<{ tenant_id: string | null }>`
        SELECT tenant_id FROM zv_audit_log
         WHERE event_type = ${`${TAG}.event`} AND resource_type = 'forged'
         ORDER BY created_at`.execute(db)
    ).rows.map((r) => r.tenant_id);
    expect(rows).toEqual([A, null]);
  });

  it('DDLManager.getRelations reads zvd_relations, filtered to one collection', async () => {
    await sql`INSERT INTO zvd_relations (name, type, source_collection, source_field, target_collection)
              VALUES (${`${TAG}-r1`}, 'm2o', ${`${TAG}_src`}, 'owner', ${`${TAG}_dst`}),
                     (${`${TAG}-r2`}, 'm2o', ${`${TAG}_other`}, 'x', ${`${TAG}_other2`})`.execute(
      db,
    );
    const touching = await DDLManager.getRelations(db, `${TAG}_dst`);
    expect(touching.map((r) => r.name)).toEqual([`${TAG}-r1`]);
    const all = (await DDLManager.getRelations(db)).map((r) => r.name);
    expect(all).toContain(`${TAG}-r1`);
    expect(all).toContain(`${TAG}-r2`);
  });
});
