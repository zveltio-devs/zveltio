-- The read predicate took the index and then read the whole table.
--
-- `004` shaped every tenant policy as `tenant_id = ANY (zveltio_visible_tenants())`.
-- That is correct, and on a selective read it is the fastest form measured. On a
-- full one it is the slowest — slower than having no index at all — because the
-- planner has nothing to estimate with: it cannot see how many elements the
-- array holds or how often they occur in the column, so it assumes a small
-- match, chooses an Index Scan, and then walks every row through it.
--
-- Wrapping the call in `(SELECT …)` makes the array an InitPlan parameter,
-- evaluated once for the query. `scalararraysel` can then reach the column
-- statistics for each element, so the estimate follows the data: a slice of the
-- table still gets the index, the whole table gets a parallel sequential scan.
--
-- Measured on 500 000 rows, `SELECT count(*), sum(length(md5(payload)))`,
-- median of 5, as the product runs it (transaction, SET LOCAL ROLE zveltio_rls,
-- transaction-local GUC), with the functions already PARALLEL SAFE from 003:
--
--                                        selective 2 500     full 500 000
--   no RLS at all                              —                123 ms
--   = ANY (fn())                ← 004        7.9 ms              406 ms
--   = ANY ((SELECT fn())::…)    ← this       7.9 ms              143 ms
--   IN (SELECT unnest(fn()))                24.7 ms              157 ms
--
-- The full column is the single-tenant self-hosted install — the unit owns every
-- row, the index cannot narrow anything, and a full scan is the correct plan.
-- That is Zveltio's common deployment, not its corner case.
--
-- Repeating the filter in the QUERY, which an earlier note recommended, does
-- nothing: measured at 408 ms against 407 ms. The policy's estimate multiplies
-- into the combined one, so a query-level predicate cannot rescue it. The shape
-- has to change in the policy or not at all.
--
-- The cast is load-bearing for a second reason: `= ANY (SELECT …)` parses as the
-- SUBQUERY form of ANY, which expects a set of rows rather than an array. Without
-- it the policy means something else.
--
-- WITH CHECK is left alone. It runs per row WRITTEN, not per row scanned, so the
-- estimate never drives a plan there.

DO $$
DECLARE
  r           record;
  n_before    int;
  n_rewritten int := 0;
  n_after     int;
  n_stale     int;
  read_expr   text;
BEGIN
  SELECT count(*) INTO n_before
    FROM pg_policies
   WHERE schemaname = 'public'
     AND qual LIKE '%zveltio_visible_tenants%'
     AND qual NOT LIKE '%SELECT zveltio_visible_tenants%';

  FOR r IN
    SELECT p.tablename,
           p.policyname,
           a.atttypid = 'uuid'::regtype AS is_uuid
      FROM pg_policies p
      JOIN pg_class c
        ON c.relname = p.tablename
       AND c.relnamespace = 'public'::regnamespace
      JOIN pg_attribute a
        ON a.attrelid = c.oid
       AND a.attname = 'tenant_id'
       AND NOT a.attisdropped
     WHERE p.schemaname = 'public'
       AND p.qual LIKE '%zveltio_visible_tenants%'
       AND p.qual NOT LIKE '%SELECT zveltio_visible_tenants%'
  LOOP
    read_expr := CASE
      WHEN r.is_uuid THEN 'tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[])'
      ELSE 'tenant_id = ANY ((SELECT zveltio_visible_tenants_text())::text[])'
    END;
    EXECUTE format('DROP POLICY %I ON %I', r.policyname, r.tablename);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO public USING (%s) WITH CHECK (%s)',
      r.policyname,
      r.tablename,
      read_expr,
      'zveltio_tenant_write_ok(tenant_id)'
    );
    n_rewritten := n_rewritten + 1;
  END LOOP;

  -- Same three checks 004 uses, for the same reason: a rewrite that silently
  -- covers most of the schema is worse than one that refuses.
  SELECT count(*) INTO n_stale
    FROM pg_policies
   WHERE schemaname = 'public'
     AND qual LIKE '%zveltio_visible_tenants%'
     AND qual NOT LIKE '%SELECT zveltio_visible_tenants%';

  SELECT count(*) INTO n_after
    FROM pg_policies
   WHERE schemaname = 'public'
     AND qual LIKE '%SELECT zveltio_visible_tenants%'
     AND with_check LIKE '%zveltio_tenant_write_ok%';

  IF n_rewritten <> n_before THEN
    RAISE EXCEPTION
      'read predicate rewrite touched % of % policies — refusing to leave the rest slow',
      n_rewritten, n_before;
  END IF;

  IF n_stale <> 0 THEN
    RAISE EXCEPTION '% policies still call the set function directly', n_stale;
  END IF;

  IF n_after < n_rewritten THEN
    RAISE EXCEPTION
      'only % of % rewritten policies carry both predicates', n_after, n_rewritten;
  END IF;

  RAISE NOTICE '[005] % tenant read predicates moved to an InitPlan', n_rewritten;
END $$;
