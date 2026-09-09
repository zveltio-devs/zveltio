/**
 * Only `god` is exempt from column-level restrictions.
 *
 * `getColumnAccess` short-circuited on a hardcoded pair of role NAMES —
 * `admin || superadmin` — before reading any configured rule. Measured against
 * every value the CHECK constraint on `"user".role` permits
 * (`001_initial.sql:1160`: god, admin, manager, member), that produced an
 * inversion:
 *
 *   member    masked        manager  masked
 *   admin     NOT masked    god      MASKED
 *   superadmin NOT masked — and not assignable, so half the condition was dead
 *
 * So the exemption went to a role that is not the most privileged one, the most
 * privileged role got the restriction, and a column rule configured against an
 * instance admin was stored, accepted, and silently never applied.
 *
 * `resolveUserRole` reads `SELECT role FROM "user"`, so the role reaching this
 * function is the INSTANCE role, not a tenant membership grade. `admin` here is
 * an instance administrator, and the instance has exactly one privileged role:
 * god.
 *
 * The exemption is now a PERMISSION resolved for an identity, not a role name:
 * `data:view_all_columns`. `rls.ts` met the same shape and says why the name is
 * the wrong mechanism — "a string comparison against a role name is invisible,
 * unauditable and impossible to revoke". So god passes THROUGH the permission
 * system rather than around it: `checkPermission` returns true for a god user
 * before consulting any policy, and everything else is deny-by-default.
 *
 * These cases pass a role with NO userId, which is the "no identity, no
 * exemption" path — the refusing direction, and what an older extension caller
 * gets. `column-access-permission.test.ts` covers the identity path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getColumnAccess } from '../../lib/tenancy/column-permissions.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLL = `colacc_${STAMP}`;
const SECRET = 'salary';

/** Every role the CHECK constraint on "user".role actually permits. */
const ASSIGNABLE = ['god', 'admin', 'manager', 'member'] as const;

d('column access without an identity exempts nobody', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    // One rule per role, because '*' would not tell us which roles the
    // short-circuit skipped — a bypassed role and a role with no rule both
    // come back empty.
    for (const role of [...ASSIGNABLE, 'superadmin']) {
      await sql`
        INSERT INTO zvd_column_permissions (collection_name, column_name, role, can_read, can_write)
        VALUES (${COLL}, ${SECRET}, ${role}, false, false)
        ON CONFLICT (collection_name, column_name, role) DO UPDATE
          SET can_read = false, can_write = false
      `.execute(db);
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLL}`
      .execute(db)
      .catch(() => {});
  });

  it('masks even god when no identity is supplied', async () => {
    // The exemption belongs to an identity, not to a role name. A caller that
    // names the role but not the user gets no exemption — the refusing
    // direction, and what `internals.ts` hands an extension written against the
    // older two-argument signature.
    const access = await getColumnAccess(db, COLL, 'god');
    expect(access.hidden.has(SECRET)).toBe(true);
  });

  it('hides the column from an instance admin', async () => {
    // The defect: this returned an empty set regardless of the rule above.
    // `resolveUserRole` reads "user".role, so this is an INSTANCE admin.
    const access = await getColumnAccess(db, COLL, 'admin');
    expect(access.hidden.has(SECRET)).toBe(true);
  });

  it('hides the column from every non-god role the schema permits', async () => {
    for (const role of ASSIGNABLE.filter((r) => r !== 'god')) {
      const access = await getColumnAccess(db, COLL, role);
      expect({ role, hidden: access.hidden.has(SECRET) }).toEqual({ role, hidden: true });
    }
  });

  it('hides the column from superadmin, which the schema does not permit anyway', async () => {
    // The dead half of the old condition. Asserted so that removing the name
    // does not quietly leave a second exemption behind for a role that only
    // ever existed in that comparison.
    const access = await getColumnAccess(db, COLL, 'superadmin');
    expect(access.hidden.has(SECRET)).toBe(true);
  });

  it('still reports no restriction where no rule is configured', async () => {
    // The control: the fix must restrict where a rule says so, not everywhere.
    const access = await getColumnAccess(db, `${COLL}_unconfigured`, 'member');
    expect(access.hidden.size).toBe(0);
    expect(access.readOnly.size).toBe(0);
  });
});
