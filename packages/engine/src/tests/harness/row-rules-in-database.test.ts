/**
 * The row rules the product defines are now enforced by the database too.
 *
 * `zvd_rls_policies` says things like "a member sees only rows they created".
 * That was enforced only by `applyRlsFilters` adding a `WHERE` to whatever query
 * the handler happened to build — so a handler that forgot one leaked, and the
 * database answered cheerfully with the wrong rows. Measured on 400 000 rows:
 * 0,068 ms to return rows the policy exists to withhold.
 *
 * These tests do the forgetting on purpose. Every query below is written the way
 * a careless handler would write it — no rule filter at all — and the rows that
 * come back are the database's answer, not the engine's.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  applyRowRulePolicy,
  invalidateRlsCache,
  type RlsIdentity,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLL = `rowrules_${STAMP}`;
const TABLE = `zvd_${COLL}`;

const ALICE = 'user-alice';
const BOB = 'user-bob';

d('row rules are enforced by the database (in-process)', () => {
  let db: Database;
  let tenant = '';
  const policyIds: string[] = [];

  const asUser = (userId: string, over: Partial<RlsIdentity> = {}): RlsIdentity => ({
    userId,
    email: `${userId}@test.local`,
    role: 'member',
    roles: ['member'],
    bypass: false,
    ...over,
  });

  /** Titles the DATABASE returns for a query with no rule filter on it. */
  const forgottenWhere = async (identity: RlsIdentity | undefined): Promise<string[]> =>
    withTenantIsolation(
      tenant,
      async (trx) => {
        const r = await sql
          .raw<{ title: string }>(`SELECT title FROM ${TABLE} ORDER BY title`)
          .execute(trx);
        return r.rows.map((x) => x.title);
      },
      { userId: identity?.userId ?? null, identity },
    );

  const setRule = async (over: Record<string, string> = {}) => {
    const row = await sql<{ id: string }>`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (
        ${COLL},
        ${over.role ?? '*'},
        ${over.field ?? 'created_by'},
        ${over.op ?? 'eq'},
        ${over.source ?? 'user_id'},
        true
      )
      RETURNING id
    `.execute(db);
    policyIds.push(row.rows[0]!.id);
    await invalidateRlsCache(COLL);
  };

  const clearRules = async () => {
    if (policyIds.length === 0) return;
    await sql`DELETE FROM zvd_rls_policies WHERE id = ANY(${sql.val(policyIds)}::uuid[])`.execute(
      db,
    );
    policyIds.length = 0;
    await invalidateRlsCache(COLL);
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    tenant = (
      await sql<{ id: string }>`SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1`.execute(db)
    ).rows[0]!.id;

    await sql
      .raw(`
      CREATE TABLE ${TABLE} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        title text NOT NULL,
        created_by text,
        bucket text,
        code integer
      )
    `)
      .execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`).execute(db);
    await sql
      .raw(
        `CREATE POLICY tenant_isolation ON ${TABLE} ` +
          `USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))`,
      )
      .execute(db);
    await sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO zveltio_rls`).execute(db);
    await sql
      .raw(`
      INSERT INTO ${TABLE} (tenant_id, title, created_by, bucket, code) VALUES
        ('${tenant}', 'alice-1', '${ALICE}', 'alpha', 5),
        ('${tenant}', 'alice-2', '${ALICE}', 'beta',  7),
        ('${tenant}', 'bob-1',   '${BOB}',   'alpha', 5),
        ('${tenant}', 'orphan',  NULL,       NULL,    NULL)
    `)
      .execute(db);

    await sql`
      INSERT INTO zvd_collections (name, display_name) VALUES (${COLL}, ${COLL})
      ON CONFLICT DO NOTHING
    `
      .execute(db)
      .catch(() => {});
  });

  afterAll(async () => {
    if (!db) return;
    await clearRules().catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`)
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_collections WHERE name = ${COLL}`.execute(db).catch(() => {});
  });

  it('leaks nothing once a rule exists, even with the filter forgotten', async () => {
    await setRule();
    expect(await forgottenWhere(asUser(ALICE))).toEqual(['alice-1', 'alice-2']);
    expect(await forgottenWhere(asUser(BOB))).toEqual(['bob-1']);
    await clearRules();
  });

  it('shows everything again when the rule is removed', async () => {
    // The policy is replaced wholesale on every change, so deleting the last
    // rule has to take the enforcement with it.
    expect((await forgottenWhere(asUser(ALICE))).length).toBe(4);
  });

  describe('it means what the engine means', () => {
    afterAll(clearRules);

    it("neq drops a NULL row, because the engine's != does", async () => {
      await setRule({ op: 'neq' });
      const seen = await forgottenWhere(asUser(ALICE));
      expect(seen).toEqual(['bob-1']);
      expect(seen).not.toContain('orphan');
      await clearRules();
    });

    it('in splits a static list on commas', async () => {
      await setRule({ field: 'bucket', op: 'in', source: 'static:alpha,beta' });
      expect(await forgottenWhere(asUser(ALICE))).toEqual(['alice-1', 'alice-2', 'bob-1']);
      await clearRules();
    });

    it('not_in keeps what is outside the list and drops NULL', async () => {
      await setRule({ field: 'bucket', op: 'not_in', source: 'static:alpha' });
      expect(await forgottenWhere(asUser(ALICE))).toEqual(['alice-2']);
      await clearRules();
    });

    it('casts into a non-text column instead of failing on the type', async () => {
      await setRule({ field: 'code', op: 'eq', source: 'static:5' });
      expect(await forgottenWhere(asUser(ALICE))).toEqual(['alice-1', 'bob-1']);
      await clearRules();
    });

    it('skips a rule whose value cannot be resolved, rather than hiding everything', async () => {
      // The engine skips such a policy — fail-open for THAT rule. A request with
      // no identity published must fall back to the tenant predicate, not vanish.
      await setRule();
      expect((await forgottenWhere(undefined)).length).toBe(4);
      await clearRules();
    });

    it('does not apply a rule to a role the caller does not hold', async () => {
      await setRule({ role: 'editor' });
      expect((await forgottenWhere(asUser(ALICE))).length).toBe(4);
      expect((await forgottenWhere(asUser(ALICE, { roles: ['member', 'editor'] }))).length).toBe(2);
      await clearRules();
    });

    it('lets an exempt session past the rules', async () => {
      // `bypass` is the engine's own answer to the question it asks before
      // applying any rule — an API key with rlsBypass, or `data:view_all`.
      await setRule();
      expect((await forgottenWhere(asUser(ALICE, { bypass: true }))).length).toBe(4);
      await clearRules();
    });
  });

  it('refuses to enforce a rule it cannot express, and says which', async () => {
    // A policy that is almost right on a security path is worse than none,
    // because it looks whole. `id` is uuid and castable; a jsonb column is not,
    // so the generator refuses — and the engine keeps applying that rule alone.
    await sql.raw(`ALTER TABLE ${TABLE} ADD COLUMN payload jsonb`).execute(db);
    await setRule({ field: 'payload' });
    const res = await applyRowRulePolicy(db, COLL);
    expect(res.applied).toBe(false);
    expect(res.skipped[0]?.reason).toContain('jsonb');
    await clearRules();
    await sql.raw(`ALTER TABLE ${TABLE} DROP COLUMN payload`).execute(db);
  });
});
