/**
 * Schema-branch previews keep `public`'s protections (routes/schema-branches.ts).
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { noteReconcile, startReconcile } from '../tenancy/index.js';
import { COLUMN_GUARD_TRIGGER } from './column-guard.js';

/**
 * Give every table in a branch schema the protections its `public` namesake has,
 * so the preview token can reach it without reaching more than `public` would.
 *
 * `CREATE TABLE … (LIKE … INCLUDING ALL)` copies columns, defaults, indexes and
 * constraints, and nothing that decides WHO may read: no grants, no row-level
 * security, no policies — and `public`'s default privileges do not apply to
 * another schema. So the branch was unreachable to the request role
 * (`zveltio_rls`), and Postgres silently drops a `search_path` entry the role
 * cannot use: every preview request read `public` and the feature did nothing.
 * Granting access alone would have been worse — a table with no
 * `tenant_isolation` policy hands every tenant's rows to whoever holds a token.
 *
 * Column protections too (L37). A sealed column (073, 075) is held column by
 * column — table-level SELECT revoked, every other column granted — so the
 * table ACL alone left the request role reading none of the branch table, and
 * every preview read of such a collection failed (42501). And 072's column write
 * guard is a trigger, which `LIKE` does not copy either. Only that trigger: the
 * table's other triggers (changelog, realtime) are behaviour with side effects in
 * `public`, not protections. The branch reads its tables, not `public`'s masking
 * views (`readSource`), so a column a read rule hides is unreadable there for
 * every actor — less than `public` serves, never more.
 *
 * So the whole set is mirrored, in one transaction, policies before grants and
 * the schema's USAGE last, so no reader ever meets a table that is reachable and
 * not yet policed. Re-runnable: the branch's own policies and grants are
 * replaced, not added to. Statements are built by Postgres (`format('%I')`,
 * `pg_get_expr`), as in Ghost DDL's `carriedOverDdl`.
 *
 * `table` limits it to that one table: how a rule changed in `public` reaches
 * branches already previewing (`refreshBranchProtections`).
 */
export async function mirrorPublicProtections(
  db: Database,
  schema: string,
  table?: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const r = await sql<{ ddl: string }>`
      WITH t AS (
        SELECT b.oid AS boid, b.relname, b.relowner AS bowner,
               coalesce(b.relacl, acldefault('r', b.relowner)) AS bacl,
               coalesce(p.relacl, acldefault('r', p.relowner)) AS pacl,
               p.oid AS poid, p.relrowsecurity, p.relforcerowsecurity
          FROM pg_class b
          JOIN pg_class p ON p.relname = b.relname
                         AND p.relnamespace = 'public'::regnamespace AND p.relkind IN ('r', 'p')
         WHERE b.relnamespace = to_regnamespace(${schema}::text) AND b.relkind = 'r'
           AND (${table ?? null}::text IS NULL OR b.relname = ${table ?? null}::text)
      ), s AS (
        SELECT 1 AS step, format('DROP POLICY %I ON %I.%I', bp.polname, ${schema}::text, t.relname) AS ddl
          FROM t JOIN pg_policy bp ON bp.polrelid = t.boid
        UNION ALL
        SELECT 1, format('DROP TRIGGER %I ON %I.%I', bg.tgname, ${schema}::text, t.relname)
          FROM t JOIN pg_trigger bg ON bg.tgrelid = t.boid AND bg.tgname = ${COLUMN_GUARD_TRIGGER}
        UNION ALL
        SELECT 2, format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', ${schema}::text, t.relname)
          FROM t WHERE t.relrowsecurity
        UNION ALL
        SELECT 2, format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', ${schema}::text, t.relname)
          FROM t WHERE t.relforcerowsecurity
        UNION ALL
        SELECT 3, format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s', p.polname, ${schema}::text, t.relname,
                 CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                 CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                               WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
                 (SELECT string_agg(CASE WHEN x = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(x)) END, ', ')
                    FROM unnest(p.polroles) x),
                 ' USING (' || pg_get_expr(p.polqual, p.polrelid) || ')',
                 ' WITH CHECK (' || pg_get_expr(p.polwithcheck, p.polrelid) || ')')
          FROM t JOIN pg_policy p ON p.polrelid = t.poid
        UNION ALL
        -- pg_get_triggerdef names the public table (qualified or not, by search_path):
        -- its first ' ON <table> ' is pointed at the branch's.
        SELECT 3, regexp_replace(pg_get_triggerdef(g.oid), ' ON [^ ]+ ', format(' ON %I.%I ', ${schema}::text, t.relname))
          FROM t JOIN pg_trigger g ON g.tgrelid = t.poid AND g.tgname = ${COLUMN_GUARD_TRIGGER}
        UNION ALL
        -- A table-level REVOKE takes the grantee's column privileges with it.
        SELECT 4, format('REVOKE ALL ON %I.%I FROM %s', ${schema}::text, x.relname,
                 CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(x.grantee)) END)
          FROM (SELECT t.relname, a.grantee FROM t, aclexplode(t.bacl) a WHERE a.grantee <> t.bowner
                UNION
                SELECT t.relname, a.grantee
                  FROM t JOIN pg_attribute ba ON ba.attrelid = t.boid AND ba.attnum > 0 AND NOT ba.attisdropped,
                       aclexplode(ba.attacl) a WHERE a.grantee <> t.bowner) x
        UNION ALL
        SELECT 5, format('GRANT %s ON %I.%I TO %s%s', a.privilege_type, ${schema}::text, t.relname,
                 CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
                 CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
          FROM t, aclexplode(t.pacl) a
        UNION ALL
        SELECT 5, format('GRANT %s (%I) ON %I.%I TO %s%s', a.privilege_type, pa.attname, ${schema}::text, t.relname,
                 CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
                 CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
          FROM t JOIN pg_attribute pa ON pa.attrelid = t.poid AND pa.attnum > 0 AND NOT pa.attisdropped
                 JOIN pg_attribute ba ON ba.attrelid = t.boid AND ba.attname = pa.attname AND NOT ba.attisdropped,
               aclexplode(pa.attacl) a
        UNION ALL
        SELECT 6, format('GRANT USAGE ON SCHEMA %I TO %s', ${schema}::text,
                 CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END)
          FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
         WHERE n.nspname = 'public' AND a.privilege_type = 'USAGE'
           AND to_regnamespace(${schema}::text) IS NOT NULL
      )
      SELECT ddl FROM s ORDER BY step
    `.execute(trx);
    for (const { ddl } of r.rows) await sql.raw(ddl).execute(trx);
  });
}

/**
 * Re-mirror `public`'s protections onto the copies of `table` (every table when
 * omitted) in each branch whose preview is enabled. A column rule changed after
 * the preview was enabled otherwise stayed behind on the branch: a rule added was
 * not held there by the database, a rule removed left the branch stricter than
 * `public`, and every preview read of the collection failed (42501). Called by
 * `invalidateColumnPermCache` after `public` is refreshed. One transaction per
 * branch table; each failure is recorded for `db_rules` as `<schema>.<table>`.
 */
export async function refreshBranchProtections(db: Database, table?: string): Promise<void> {
  const record = table
    ? (key: string, err?: unknown) => noteReconcile('branch_protections', key, err)
    : startReconcile('branch_protections');
  let rows: Array<{ schema: string; relname: string }>;
  try {
    rows = (
      await sql<{ schema: string; relname: string }>`
        SELECT DISTINCT b.preview_schema AS schema, c.relname::text AS relname
          FROM zv_schema_branches b
          JOIN pg_class c ON c.relnamespace = to_regnamespace(b.preview_schema) AND c.relkind = 'r'
          JOIN pg_class p ON p.relname = c.relname
                         AND p.relnamespace = 'public'::regnamespace AND p.relkind IN ('r', 'p')
         WHERE b.preview_enabled AND b.preview_schema IS NOT NULL
           AND (${table ?? null}::text IS NULL OR c.relname = ${table ?? null}::text)
      `.execute(db)
    ).rows;
  } catch (err) {
    console.warn(`[schema-branches] previews not re-mirrored — ${record('*', err)}`);
    return;
  }
  record('*', undefined);
  for (const r of rows) {
    const key = `${r.schema}.${r.relname}`;
    try {
      await mirrorPublicProtections(db, r.schema, r.relname);
      record(key, undefined);
    } catch (err) {
      console.warn(`[schema-branches] ${key}: protections not re-mirrored — ${record(key, err)}`);
    }
  }
}
