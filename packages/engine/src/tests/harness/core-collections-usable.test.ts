/**
 * A core collection has to be more than a table.
 *
 * `contacts`, `organizations` and `transactions` are created one of two ways
 * depending on what else is installed. On a bare instance `ensureCoreCollections`
 * builds them through `DDLManager`. On an instance that has the crm extension —
 * which is most of them — crm's `001_initial.sql` gets there first with raw SQL,
 * and the bootstrap used to see the table, conclude there was nothing to do, and
 * skip everything that makes a collection usable:
 *
 *   - no `zvd_collections` row, so the Studio lists nothing and the schema
 *     cannot be discovered
 *   - no tenant RLS from the host (the table's isolation then depends entirely
 *     on an optional extension's own migration)
 *   - no default grants, which under deny-by-default means `/api/data/contacts`
 *     answers 403 to every user who is not an administrator
 *
 * Measured on a fresh install with the extensions on disk: the three tables
 * present, `zvd_collections` empty, and an ordinary member holding access to
 * twenty extension resources and zero collections.
 *
 * The skip predates deny-by-default and was harmless while a blanket wildcard
 * covered the missing grant. That is the recurring shape in this codebase — a
 * gap that only becomes visible once something coarser stops papering over it —
 * and it is why this asserts the END STATE rather than the code path: whichever
 * way the collection came into existence, these three things have to be true.
 *
 * State assertions only, no mutation, because this database is shared with 264
 * other test files. CI builds it fresh each run, so a regression in either the
 * create path or the adopt path fails here.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { CORE_COLLECTIONS } from '../../core-collections/index.js';

const d = harnessAvailable() ? describe : describe.skip;

d('core collections are usable, not just present', () => {
  it('each one is registered so the Studio can see it', async () => {
    const { db } = await getTestApp();
    for (const def of CORE_COLLECTIONS) {
      const row = await db
        .selectFrom('zvd_collections')
        .select('name')
        .where('name', '=', def.name)
        .executeTakeFirst();
      expect(row?.name, `'${def.name}' has no zvd_collections row`).toBe(def.name);
    }
  });

  it('each one is isolated per tenant by the host', async () => {
    // FORCE as well as ENABLE: without forcing, the owning role bypasses the
    // policy, and the engine connects as the owner.
    const { db } = await getTestApp();
    for (const def of CORE_COLLECTIONS) {
      const res = await sql<{ enabled: boolean; forced: boolean }>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
          FROM pg_class WHERE relname = ${`zvd_${def.name}`}
      `.execute(db);
      expect(res.rows[0]?.enabled, `RLS not enabled on zvd_${def.name}`).toBe(true);
      expect(res.rows[0]?.forced, `RLS not forced on zvd_${def.name}`).toBe(true);
    }
  });

  it('each one is reachable by an ordinary member', async () => {
    // The assertion that would have caught the 403. `tenant_member` gets read,
    // create and update from `materializeDefaultGrants`; a core collection with
    // no rows here is one that only administrators can open.
    const { db } = await getTestApp();
    for (const def of CORE_COLLECTIONS) {
      const rows = await sql<{ v3: string }>`
        SELECT v3 FROM zvd_permissions
         WHERE ptype = 'p' AND v0 = 'tenant_member' AND v2 = ${def.name}
      `.execute(db);
      const actions = rows.rows.map((r) => r.v3).sort();
      expect(actions, `no default grants for '${def.name}'`).toEqual([
        'create',
        'read',
        'update',
      ]);
    }
  });

  it('and no member role may delete, which proves the grants are scoped', async () => {
    // The control. Three actions, not four — a fix that granted everything
    // would satisfy the case above and quietly hand out deletion.
    const { db } = await getTestApp();
    const rows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zvd_permissions
       WHERE ptype = 'p' AND v0 IN ('tenant_member', 'tenant_viewer')
         AND v3 = 'delete'
    `.execute(db);
    expect(rows.rows[0]?.n).toBe(0);
  });
});
