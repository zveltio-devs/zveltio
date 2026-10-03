-- 047_sync_tombstone_search_path.sql
--
-- `zveltio_sync_tombstone()` (032) is SECURITY DEFINER with
-- `search_path = pg_catalog, public`. A path that does not name pg_temp searches
-- it FIRST for relations, so a writer that may create temporary objects —
-- `zveltio_ext`, `zveltio_worker`, `zveltio_rls` all hold TEMPORARY through
-- PUBLIC — could plant `pg_temp.zv_sync_tombstones` with a trigger of its own
-- and delete one collection row: the function's INSERT then lands in the temp
-- table and fires that trigger as the function's OWNER, the engine role.
-- Measured as `zveltio_worker`: the planted trigger ran as `postgres` and wrote a
-- `zvd_permissions` row (tests/harness/restricted-role-triggers.test.ts).
--
-- pg_temp last is the documented pattern for SECURITY DEFINER; the body is
-- unchanged. Re-runnable: ALTER … SET replaces the value.

DO $$
BEGIN
  IF to_regprocedure('public.zveltio_sync_tombstone()') IS NOT NULL THEN
    ALTER FUNCTION public.zveltio_sync_tombstone() SET search_path = pg_catalog, public, pg_temp;
  END IF;
END $$;

-- DOWN

DO $$
BEGIN
  IF to_regprocedure('public.zveltio_sync_tombstone()') IS NOT NULL THEN
    ALTER FUNCTION public.zveltio_sync_tombstone() SET search_path = pg_catalog, public;
  END IF;
END $$;
