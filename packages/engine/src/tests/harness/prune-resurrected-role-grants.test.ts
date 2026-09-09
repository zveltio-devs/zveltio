/**
 * Migration 012 removes the role grants #451 stopped creating — and nothing else.
 *
 * Before #451 the Casbin adapter's `removePolicy` compared `v3 = NULL` on
 * every three-value `g` rule, which is never true, so revoking a tenant role
 * deleted no row. Casbin dropped it from the in-memory model, so the revocation
 * held until the next policy load and came back on the following boot, where
 * `some(allow)` makes the widest surviving grant win. #451 fixed the
 * comparison; the rows already written stayed.
 *
 * The risk in cleaning them up is not missing one, it is deleting a grant that
 * is legitimately unsupported by `zv_tenant_users`. Three such grants exist and
 * each is planted here, because a migration that removes authorization rows is
 * only as good as the cases it declines to touch:
 *
 *   - an invited `manager`: `zv_tenant_users.role` is `member` (the column takes
 *     four grades and `manager` is not one) while the Casbin grant is
 *     `tenant_manager`. Divergent by design, per routes/auth.ts.
 *   - a god grant in domain `*`, which no membership row can ever match.
 *   - a role-inheritance edge, where `v0` is a role rather than a user.
 *
 * Planting only the drift would let a migration that deletes every `g` row pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const TENANT = '00000000-0000-0000-0000-0000000009b2';
const DEMOTED = `prune-demoted-${STAMP}`;
const REMOVED = `prune-removed-${STAMP}`;
const MANAGER = `prune-manager-${STAMP}`;
const GODLIKE = `prune-god-${STAMP}`;

async function grants(db: Database, user: string): Promise<string[]> {
  const r = await sql<{ v1: string }>`
    SELECT v1 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${user} ORDER BY v1
  `.execute(db);
  return r.rows.map((x) => x.v1);
}

d('migration 012 prunes only role grants no membership supports', () => {
  let db: Database;
  let up = '';

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const file = Bun.file(
      new URL('../../db/migrations/sql/012_prune_resurrected_role_grants.sql', import.meta.url),
    );
    up = parseMigrationFile(await file.text()).up;

    await sql`
      INSERT INTO zv_tenants (id, slug, name, status)
      VALUES (${TENANT}::uuid, ${`prune-probe-${STAMP}`}, 'Prune Probe', 'active')
      ON CONFLICT (id) DO UPDATE SET status = 'active'
    `.execute(db);

    for (const [id, name] of [
      [DEMOTED, 'Demoted'],
      [REMOVED, 'Removed'],
      [MANAGER, 'Invited Manager'],
      [GODLIKE, 'Instance Admin'],
    ]) {
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        VALUES (${id}, ${name}, ${`${id}@probe.invalid`}, false, now(), now())
        ON CONFLICT (id) DO NOTHING
      `.execute(db);
    }

    // Memberships: the durable fact each grant is measured against.
    await sql`
      INSERT INTO zv_tenant_users (tenant_id, user_id, role) VALUES
        (${TENANT}::uuid, ${DEMOTED}, 'member'),
        (${TENANT}::uuid, ${MANAGER}, 'member')
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `.execute(db);

    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES
        -- The drift: demoted to member, the owner row survived the revoke.
        ('g', ${DEMOTED}, 'tenant_owner',  ${TENANT}),
        ('g', ${DEMOTED}, 'tenant_member', ${TENANT}),
        -- The drift: removed from the tenant, both rows survived.
        ('g', ${REMOVED}, 'tenant_admin',  ${TENANT}),
        ('g', ${REMOVED}, 'tenant_member', ${TENANT}),
        -- Legitimate: an invited manager. Membership says member, by design.
        ('g', ${MANAGER}, 'tenant_manager', ${TENANT}),
        -- Legitimate: an instance-level grant, domain '*'.
        ('g', ${GODLIKE}, 'tenant_admin',  '*'),
        -- Legitimate: role inheritance. v0 is a role, not a user.
        ('g', 'tenant_admin', 'tenant_member', ${TENANT})
    `.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${TENANT} OR v0 IN (${DEMOTED}, ${REMOVED}, ${MANAGER}, ${GODLIKE})`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_permissions_pruned_012 WHERE v2 = ${TENANT}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${TENANT}::uuid`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM "user" WHERE id IN (${DEMOTED}, ${REMOVED}, ${MANAGER}, ${GODLIKE})`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT}::uuid`.execute(db).catch(() => {});
  });

  it('leaves the demoted user with only the grade the membership names', async () => {
    expect(await grants(db, DEMOTED)).toEqual(['tenant_member', 'tenant_owner']);
    await sql.raw(up).execute(db);
    // The whole point: after a policy reload this user is no longer an owner.
    expect(await grants(db, DEMOTED)).toEqual(['tenant_member']);
  });

  it('leaves a removed member with no tenant grants at all', async () => {
    expect(await grants(db, REMOVED)).toEqual([]);
  });

  it('keeps an invited manager, whose membership says member by design', async () => {
    // The case that makes "grant disagrees with membership" the wrong rule.
    expect(await grants(db, MANAGER)).toEqual(['tenant_manager']);
  });

  it('keeps an instance-level grant in domain *', async () => {
    expect(await grants(db, GODLIKE)).toEqual(['tenant_admin']);
  });

  it('keeps a role-inheritance edge, where v0 is a role', async () => {
    expect(await grants(db, 'tenant_admin')).toEqual(['tenant_member']);
  });

  it('records every pruned row so the deletion is reversible', async () => {
    const r = await sql<{ v0: string; v1: string; membership: string | null }>`
      SELECT v0, v1, membership FROM zvd_permissions_pruned_012
       WHERE v2 = ${TENANT} ORDER BY v0, v1
    `.execute(db);
    expect(r.rows).toEqual([
      { v0: DEMOTED, v1: 'tenant_owner', membership: 'member' },
      { v0: REMOVED, v1: 'tenant_admin', membership: null },
      { v0: REMOVED, v1: 'tenant_member', membership: null },
    ]);
  });

  it('is idempotent: a second run prunes nothing and loses nothing', async () => {
    await sql.raw(up).execute(db);
    expect(await grants(db, DEMOTED)).toEqual(['tenant_member']);
    expect(await grants(db, MANAGER)).toEqual(['tenant_manager']);
    const n = await sql<{ c: string }>`
      SELECT count(*) AS c FROM zvd_permissions_pruned_012 WHERE v2 = ${TENANT}
    `.execute(db);
    expect(n.rows[0]?.c).toBe('3');
  });
});
