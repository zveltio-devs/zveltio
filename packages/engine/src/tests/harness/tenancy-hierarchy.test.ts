/**
 * The tree, proved on rows.
 *
 * Until migration 003 the tenant predicate was an equality against one GUC, so
 * two questions had one answer: a unit saw its own rows and nothing else, in
 * both directions. Sibling isolation worked. A level ABOVE, consolidating what
 * its subordinates filed, could not be expressed at all — which is the shape of
 * a national authority with 41 county directorates, and of any group with
 * subsidiaries.
 *
 * The case that matters here is `the root reads both siblings`. On the code
 * that preceded this migration it returns one row, not two, whatever the
 * assignment says. It is the proof that the model actually changed rather than
 * gaining columns nothing reads.
 *
 * Written against `withTenantIsolation`, not against hand-set GUCs, so it also
 * covers the wiring: resolving an assignment into a visible set is the
 * middleware's job, and a test that set the GUCs itself would pass with that
 * wiring deleted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { asTenant, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { applyTenantRLS, withTenantIsolation } from '../../lib/tenancy/tenant-manager.js';

const d = harnessAvailable() ? describe : describe.skip;

const ROOT = '3a000000-0000-0000-0000-000000000090';
const SIS_A = '3a000000-0000-0000-0000-0000000000a1';
const SIS_B = '3a000000-0000-0000-0000-0000000000b2';

/** A plain tenant table, isolated the way every collection is. */
const PLAIN = 'zvd_hier_probe_plain';

const USER_ROOT = 'hier-probe-user-root';
const USER_A = 'hier-probe-user-a';
const USER_EXPIRED = 'hier-probe-user-expired';

d('tenancy hierarchy', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());

    // ── the tree: one root, two siblings under it ──
    await sql`
      INSERT INTO zv_tenants (id, slug, name, parent_id) VALUES
        (${ROOT}::uuid,  'hier-root', 'Root Authority', NULL),
        (${SIS_A}::uuid, 'hier-a',    'County A',       ${ROOT}::uuid),
        (${SIS_B}::uuid, 'hier-b',    'County B',       ${ROOT}::uuid)
      ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id
    `.execute(db);

    for (const [id, email] of [
      [USER_ROOT, 'hier-root@test.invalid'],
      [USER_A, 'hier-a@test.invalid'],
      [USER_EXPIRED, 'hier-expired@test.invalid'],
    ]) {
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
        VALUES (${id}, ${id}, ${email}, true, 'member', now(), now())
        ON CONFLICT (id) DO NOTHING
      `.execute(db);
    }

    // ── the assignments, which are what is actually configured ──
    await sql`DELETE FROM zv_tenant_users WHERE user_id IN (${USER_ROOT}, ${USER_A}, ${USER_EXPIRED})`.execute(
      db,
    );
    await sql`
      INSERT INTO zv_tenant_users (tenant_id, user_id, role, read_scope, valid_from, valid_to) VALUES
        (${ROOT}::uuid,  ${USER_ROOT},    'admin',  'subtree', now() - interval '1 day', NULL),
        (${SIS_A}::uuid, ${USER_A},       'member', 'self',    now() - interval '1 day', NULL),
        (${SIS_A}::uuid, ${USER_EXPIRED}, 'member', 'self',    now() - interval '2 day', now() - interval '1 day')
    `.execute(db);

    await sql.raw(`DROP TABLE IF EXISTS ${PLAIN}`).execute(db);
    await sql
      .raw(`CREATE TABLE ${PLAIN} (id serial primary key, tenant_id uuid NOT NULL, label text)`)
      .execute(db);
    await sql.raw(`ALTER TABLE ${PLAIN} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`ALTER TABLE ${PLAIN} FORCE ROW LEVEL SECURITY`).execute(db);
    // The policy every collection gets, so test 3 fails if applyTenantRLS ever
    // checks writes with the read predicate.
    await applyTenantRLS(db, PLAIN);
    await sql
      .raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PLAIN} TO zveltio_rls`)
      .execute(db)
      .catch(() => undefined);
    await sql
      .raw(`GRANT USAGE, SELECT ON SEQUENCE ${PLAIN}_id_seq TO zveltio_rls`)
      .execute(db)
      .catch(() => undefined);
    for (const [t, label] of [
      [ROOT, 'root-row'],
      [SIS_A, 'a-row'],
      [SIS_B, 'b-row'],
    ]) {
      await asTenant(db, t!, (trx) =>
        sql.raw(`INSERT INTO ${PLAIN} (tenant_id, label) VALUES ('${t}', '${label}')`).execute(trx),
      );
    }
  });

  afterAll(async () => {
    await sql
      .raw(`DROP TABLE IF EXISTS ${PLAIN}`)
      .execute(db)
      .catch(() => undefined);
    await sql`DELETE FROM zv_tenant_users WHERE user_id IN (${USER_ROOT}, ${USER_A}, ${USER_EXPIRED})`
      .execute(db)
      .catch(() => undefined);
    await sql`DELETE FROM "user" WHERE id IN (${USER_ROOT}, ${USER_A}, ${USER_EXPIRED})`
      .execute(db)
      .catch(() => undefined);
    await sql`DELETE FROM zv_tenants WHERE id IN (${SIS_A}::uuid, ${SIS_B}::uuid, ${ROOT}::uuid)`
      .execute(db)
      .catch(() => undefined);
  });

  /** Read a probe table exactly as a request would: one unit, one acting user. */
  async function readAs(userId: string, tenantId: string, table: string): Promise<string[]> {
    return withTenantIsolation(
      tenantId,
      async (trx) => {
        const r = await sql<{ label: string }>`
          SELECT label FROM ${sql.id(table)} ORDER BY label
        `.execute(trx);
        return r.rows.map((x) => x.label);
      },
      { userId },
    );
  }

  it('1. a sibling does not see the other sibling', async () => {
    expect(await readAs(USER_A, SIS_A, PLAIN)).toEqual(['a-row']);
  });

  it('2. the root sees both siblings and itself', async () => {
    // The case that cannot hold under an equality predicate, at any setting.
    expect(await readAs(USER_ROOT, ROOT, PLAIN)).toEqual(['a-row', 'b-row', 'root-row']);
  });

  it('3. the root cannot WRITE into a sibling', async () => {
    // Reading upward and writing downward are not the same permission, and the
    // whole point of splitting the predicate is that widening the first did not
    // widen the second. The data belong to the subordinate.
    await expect(
      withTenantIsolation(
        ROOT,
        async (trx) => {
          await sql`
            INSERT INTO ${sql.id(PLAIN)} (tenant_id, label)
            VALUES (${SIS_A}::uuid, 'written-from-above')
          `.execute(trx);
        },
        { userId: USER_ROOT },
      ),
    ).rejects.toThrow();

    // And an UPDATE of a row it can legitimately SEE is refused for the same
    // reason — a reach that could edit what it consolidates would be the
    // failure this design exists to avoid. Skipped rather than failed since B09:
    // the existing row is held to the own node, as for DELETE.
    const updated = await withTenantIsolation(
      ROOT,
      async (trx) =>
        (
          await sql`
            UPDATE ${sql.id(PLAIN)} SET label = 'edited-from-above' WHERE label = 'a-row'
          `.execute(trx)
        ).numAffectedRows,
      { userId: USER_ROOT },
    );
    expect(updated).toBe(0n);
    expect(await readAs(USER_A, SIS_A, PLAIN)).toEqual(['a-row']);
  });

  it('4. an expired assignment sees nothing', async () => {
    // Not "sees its own unit". Revocation is a date, and a date that has passed
    // has to mean the same as never having been granted — otherwise `valid_to`
    // is decoration. Note this is NOT the same as having no assignment at all,
    // which is a god user or an API key and keeps the old behaviour.
    expect(await readAs(USER_EXPIRED, SIS_A, PLAIN)).toEqual([]);
  });

  it('5. a row written at the root is NOT visible below', async () => {
    // Head-office payroll does not become county-visible merely by sitting
    // higher. Reading reaches down (`read_scope`), never up.
    expect(await readAs(USER_A, SIS_A, PLAIN)).toEqual(['a-row']);
  });

  it('6. downward inheritance is gone, not just unused (078)', async () => {
    // 004 shipped an `inherit_down` flag no policy ever read, two-argument
    // `zveltio_tenant_scope_ok` overloads and an ancestor set fed by a walk on
    // every request. Setting the flag granted nothing; 078 removed all of it.
    const r = await sql<{ col: boolean; fns: string[] }>`
      SELECT EXISTS (
               SELECT 1 FROM information_schema.columns
                WHERE table_name = 'zvd_collections' AND column_name = 'inherit_down'
             ) AS col,
             ARRAY(
               SELECT p.oid::regprocedure::text FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace
                  AND (p.proname IN ('zveltio_ancestor_tenants', 'zveltio_ancestor_tenants_text',
                                     'zveltio_tenant_ancestors')
                       OR (p.proname = 'zveltio_tenant_scope_ok' AND p.pronargs = 2))
                ORDER BY 1
             ) AS fns
    `.execute(db);
    expect(r.rows[0]).toEqual({ col: false, fns: [] });
  });

  it('7. a unit is never its own ancestor', async () => {
    // A cycle does not corrupt data here, it hangs: every walk is recursive.
    await expect(
      sql`UPDATE zv_tenants SET parent_id = ${SIS_A}::uuid WHERE id = ${ROOT}::uuid`.execute(db),
    ).rejects.toThrow();
  });

  it('8. a caller with no user still behaves as it did before the hierarchy', async () => {
    // Background workers, boot reconcilers, API-key traffic and single-tenant
    // installs all arrive with no assignment to resolve. They must land on the
    // old equality, not on an empty set and not on everything.
    const rows = await withTenantIsolation(SIS_B, async (trx) => {
      const r = await sql<{ label: string }>`
        SELECT label FROM ${sql.id(PLAIN)} ORDER BY label
      `.execute(trx);
      return r.rows.map((x) => x.label);
    });
    expect(rows).toEqual(['b-row']);
  });
});
