/**
 * A revoked role must be revoked in the table, not only in memory.
 *
 * The Casbin adapter's `removePolicy` compared `v0` through `v3` no matter how
 * many values the rule carried. A `p` policy has four (sub, dom, obj, act) and
 * matched correctly; every `g` role grant has three, so the fourth comparison
 * became `v3 = NULL` — never true in SQL — and the DELETE removed nothing.
 *
 * Casbin drops the rule from its in-memory model regardless, so revocation
 * looked like it worked, the audit line said it worked, and it kept working
 * right up until the next policy load. Measured before the fix:
 *
 *   granted owner        → table: tenant_owner
 *   demoted to member    → table: tenant_member, tenant_owner
 *   after a restart      → owner=true  member=true
 *
 * Three routes revoke through this path: removing a member from a tenant,
 * changing a member's role — which deletes every prior grant before adding the
 * new one — and removing a role-inheritance edge. The effect rule is
 * `some(where p.eft == allow)`, so once the old row is back the widest grant
 * wins and the demotion is undone.
 */
import { describe, expect, it, beforeAll, afterEach } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp } from '../../testing/app-harness.js';
import { getEnforcer } from '../../lib/tenancy/index.js';

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)('revoking a role reaches the database', () => {
  let db: any;
  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  const USER = `revoke-probe-${crypto.randomUUID()}`;
  const DOM = `revoke-dom-${crypto.randomUUID()}`;

  afterEach(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${USER}`.execute(db);
    await (await getEnforcer()).loadPolicy();
  });

  /** The roles this grant actually holds in the table, not in the model. */
  async function rowsFor(): Promise<string[]> {
    const r = await sql<{ v1: string }>`
      SELECT v1 FROM zvd_permissions
       WHERE ptype = 'g' AND v0 = ${USER} AND v2 = ${DOM}
       ORDER BY v1
    `.execute(db);
    return r.rows.map((x) => x.v1);
  }

  it('deletes the row, so a policy reload does not bring the role back', async () => {
    const e = await getEnforcer();
    await e.addRoleForUser(USER, 'tenant_admin', DOM);
    expect(await rowsFor()).toEqual(['tenant_admin']);

    await e.deleteRoleForUser(USER, 'tenant_admin', DOM);
    expect(await rowsFor()).toEqual([]);

    // What the next engine start reads.
    await e.loadPolicy();
    expect(await e.hasRoleForUser(USER, 'tenant_admin', DOM)).toBe(false);
  });

  it('survives a demotion the way the members route performs it', async () => {
    const e = await getEnforcer();
    await e.addRoleForUser(USER, 'tenant_owner', DOM);

    // routes/tenants.ts: drop every tenant role, then add the chosen one.
    for (const r of ['tenant_owner', 'tenant_admin', 'tenant_member']) {
      await e.deleteRoleForUser(USER, r, DOM);
    }
    await e.addRoleForUser(USER, 'tenant_member', DOM);
    expect(await rowsFor()).toEqual(['tenant_member']);

    await e.loadPolicy();
    expect(await e.hasRoleForUser(USER, 'tenant_owner', DOM)).toBe(false);
    expect(await e.hasRoleForUser(USER, 'tenant_member', DOM)).toBe(true);
  });

  it('does not take a four-value policy with it', async () => {
    // The absent columns are matched with IS NULL, so removing a three-value
    // grant must not reach a `p` rule that happens to share its first columns.
    const e = await getEnforcer();
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
      VALUES ('p', ${USER}, ${DOM}, 'invoices', 'read')
    `.execute(db);
    await e.loadPolicy();

    await e.addRoleForUser(USER, 'tenant_member', DOM);
    await e.deleteRoleForUser(USER, 'tenant_member', DOM);

    const remaining = await sql<{ ptype: string }>`
      SELECT ptype FROM zvd_permissions WHERE v0 = ${USER}
    `.execute(db);
    expect(remaining.rows.map((r) => r.ptype)).toEqual(['p']);
  });
});
