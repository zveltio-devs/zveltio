/**
 * An index on a row rule's column is reached through the ENGINE's filter, not
 * through the row-rule policy — pinned here so the filter is not removed as
 * "redundant now that the database enforces the rule".
 *
 * The generated policy is `exempt OR (actor guard OR role guard OR condition)`.
 * The guards are per-session values the planner only sees as InitPlan params,
 * and Postgres cannot index a disjunction one of whose arms is a param: no
 * BitmapOr arm can be built for it. Measured on 300 000 rows, rule
 * `created_by eq user_id`, inside `withTenantIsolation` as `zveltio_rls`:
 *
 *   policy alone (no WHERE)        Parallel Seq Scan, Filter (... OR created_by = (InitPlan 3).col1)   15.9 ms
 *   engine query (applyRlsFilters) Bitmap Index Scan, Index Cond: (created_by = 'user-7'::text)         1.1 ms
 *
 * Reshaping the predicate does not change that — splitting it into one
 * RESTRICTIVE policy per term keeps every OR, and PERMISSIVE policies would be
 * ORed with the permissive tenant policy, which widens access. So the policy is
 * the second line of defence and `applyRlsFilters` is what makes the read fast;
 * both stay.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Kysely, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  applyRowRulePolicy,
  invalidateRlsCache,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { applyRlsFilters, getRlsFilters } from '../../lib/tenancy/rls.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLL = `rrindex_${Date.now()}`;
const TABLE = `zvd_${COLL}`;
const INDEX = `${TABLE}_created_by`;
const USER = 'user-7';

/** Every index a plan node reads, from EXPLAIN (FORMAT JSON). */
function indexesIn(node: Record<string, unknown>): string[] {
  const own = typeof node['Index Name'] === 'string' ? [node['Index Name'] as string] : [];
  const kids = (node.Plans as Record<string, unknown>[] | undefined) ?? [];
  return [...own, ...kids.flatMap(indexesIn)];
}

d('row rule column index (in-process)', () => {
  let db: Database;
  let tenant = '';

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
          created_by text
        );
        INSERT INTO ${TABLE} (tenant_id, created_by)
          SELECT '${tenant}', 'user-' || (g % 1000) FROM generate_series(1, 20000) g;
        CREATE INDEX ${INDEX} ON ${TABLE} (created_by);
        ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON ${TABLE}
          USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]));
        GRANT SELECT ON ${TABLE} TO zveltio_rls;
        ANALYZE ${TABLE};
      `)
      .execute(db);
    await sql`INSERT INTO zvd_collections (name, display_name) VALUES (${COLL}, ${COLL})
              ON CONFLICT DO NOTHING`.execute(db);
    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLL}, '*', 'created_by', 'eq', 'user_id', true)
    `.execute(db);
    await invalidateRlsCache(COLL);
    expect((await applyRowRulePolicy(db, COLL)).applied).toBe(true);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLL}`.execute(db);
    await invalidateRlsCache(COLL);
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${COLL}`.execute(db);
  });

  it('the filtered read reaches the rule column index as the restricted role', async () => {
    // The filters the list handler asks for, applied the way it applies them.
    const filters = await getRlsFilters(COLL, { id: USER, email: '', role: 'member' }, 'session');
    expect(filters.length).toBe(1);

    const identity = { userId: USER, email: '', role: 'member', roles: ['member'], bypass: false };
    const { role, plan, rows } = await withTenantIsolation(
      tenant,
      async (trx) => {
        // A runtime table, typed loosely the way dynamicDb is.
        const loose = trx as unknown as Kysely<Record<string, { id: string }>>;
        const { sql: text, parameters } = applyRlsFilters(
          loose.selectFrom(TABLE).select('id'),
          filters,
        ).compile();
        const explain = await sql<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>`
          EXPLAIN (FORMAT JSON) ${sql.raw(text.replace(/\$(\d+)/g, (_, i) => `'${parameters[Number(i) - 1]}'`))}
        `.execute(trx);
        const n = await sql
          .raw(`SELECT count(*)::int AS n FROM ${TABLE}`)
          .execute(trx)
          .then((r) => (r.rows[0] as { n: number }).n);
        const who = await sql<{ u: string }>`SELECT current_user AS u`.execute(trx);
        return { role: who.rows[0]!.u, plan: explain.rows[0]!['QUERY PLAN'][0]!.Plan, rows: n };
      },
      { userId: USER, identity },
    );

    expect(role).toBe('zveltio_rls'); // the real path, not the table owner
    expect(rows).toBe(20); // the policy still binds: 20 000 rows / 1 000 owners
    expect(indexesIn(plan)).toContain(INDEX);
  });
});
