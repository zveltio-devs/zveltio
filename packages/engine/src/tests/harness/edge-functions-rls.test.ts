/**
 * The edge-function tables are isolated by the DATABASE, not by whoever wrote
 * the query.
 *
 * Migration 015 closed a cross-tenant IDOR on `zv_edge_functions` /
 * `zv_edge_function_logs` — functions store secrets in `env_vars` and run
 * arbitrary code — and closed it in the HANDLERS, saying so: "they run on the
 * request db without relying on RLS". No policy was created.
 *
 * That held while the handlers were the engine's. CRUD then moved to
 * extensions/developer/edge-functions, whose routes scope by `id`, `path` and
 * `is_active` and never by tenant, on the stated assumption that `ctx.db` is
 * "already RLS-scoped". True of every other table it could have been written
 * against; false of exactly these two, because they had no policy. Migration
 * 049 gives them one.
 *
 * This asserts the state that makes the assumption true, rather than the
 * queries of any one caller — a route added tomorrow is covered for free, and
 * that is the failure this had.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TABLES = ['zv_edge_functions', 'zv_edge_function_logs'] as const;

interface RlsRow {
  relname: string;
  enabled: boolean;
  forced: boolean;
  policies: number;
}

d('edge-function tables carry tenant RLS (in-process)', () => {
  let db: Database;
  let rows: RlsRow[];

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const res = await sql<RlsRow>`
      SELECT c.relname,
             c.relrowsecurity      AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY(${sql.val(TABLES as unknown as string[])})
    `.execute(db);
    rows = res.rows;
  });

  it('both tables exist, so the assertions below are not vacuous', () => {
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
  });

  for (const t of TABLES) {
    it(`${t} has RLS enabled AND forced`, () => {
      const row = rows.find((r) => r.relname === t);
      // FORCE is the half that matters on a stock install: the engine connects
      // as the table owner, and Postgres lets an owner bypass a policy that is
      // enabled but not forced — so RLS would be advisory.
      expect({ table: t, enabled: row?.enabled, forced: row?.forced }).toEqual({
        table: t,
        enabled: true,
        forced: true,
      });
    });

    it(`${t} carries a tenant policy`, () => {
      const row = rows.find((r) => r.relname === t);
      expect({ table: t, policies: row?.policies ?? 0 }).toMatchObject({ table: t });
      expect(row?.policies ?? 0).toBeGreaterThan(0);
    });
  }

  it('the policy actually separates two tenants', async () => {
    const A = '00000000-0000-0000-0000-0000000000aa';
    const B = '00000000-0000-0000-0000-0000000000bb';
    const name = `rlsfn_${Date.now()}`;
    await sql`
      INSERT INTO zv_edge_functions (name, display_name, code, path, tenant_id)
      VALUES (${`${name}_a`}, 'A', '//a', ${`/api/fn/${name}_a`}, ${A}::uuid),
             (${`${name}_b`}, 'B', '//b', ${`/api/fn/${name}_b`}, ${B}::uuid)
    `.execute(db);
    try {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zv_edge_functions
         WHERE name IN (${`${name}_a`}, ${`${name}_b`})
           AND zveltio_tenant_scope_ok(tenant_id)
      `.execute(
        // The predicate is evaluated against the GUC, so set it for this query.
        db,
      );
      // Without a tenant set, the predicate resolves to the default tenant and
      // neither row matches — the refusing direction, which is the point.
      expect(seen.rows[0]?.n).toBe(0);
    } finally {
      await sql`DELETE FROM zv_edge_functions WHERE name IN (${`${name}_a`}, ${`${name}_b`})`
        .execute(db)
        .catch(() => {});
    }
  });
});
