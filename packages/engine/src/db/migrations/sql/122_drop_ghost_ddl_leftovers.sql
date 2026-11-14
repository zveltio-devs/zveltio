-- 122_drop_ghost_ddl_leftovers.sql
--
-- ADR 0041: a field is added in place; the engine no longer copies and swaps a
-- table (the Ghost DDL path is deleted). An instance upgraded while a run was
-- abandoned can still hold its work: `_zv_ghost_<t>` (the copy),
-- `_zv_old_<t>` (the original after a swap whose 60-second DROP never ran),
-- `_zv_changelog_<t>`, and on the live table `<t>` the trigger
-- `_zv_trg_ghost_<t>` with its function `_zv_trg_ghost_<t>_fn`, which writes
-- every row change into that changelog for good. This drops them; `<t>` itself
-- is not touched. It is the last trace of the ghost path, for one release.
--
-- By name and IF EXISTS, in the schema the engine created them in: a run that a
-- pre-0041 instance is still finishing either swaps first (its `_zv_ghost_`
-- name is gone, `_zv_old_` is dropped) or fails on the missing copy, which
-- leaves the live table as it was.
--
-- Every object is the engine role's own (it created them), so no superuser is
-- needed. One the running role cannot drop is reported and kept, and with its
-- trigger kept, so are the function and changelog it writes into: a dropped
-- changelog under a live trigger would fail every write to the table.

DO $$
DECLARE
  ns oid := (SELECT oid FROM pg_namespace WHERE nspname = current_schema());
  kept text[] := '{}';
  r record;
BEGIN
  FOR r IN
    SELECT t.tgname, c.relname
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND c.relnamespace = ns
       AND t.tgname LIKE '\_zv\_trg\_ghost\_%'
  LOOP
    BEGIN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.tgname, r.relname);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING '122: cannot drop trigger % on %, kept with its changelog: %',
        r.tgname, r.relname, SQLERRM;
      -- The changelog's name as Postgres truncated it (63 bytes).
      kept := kept || left('_zv_changelog_' || r.relname, 63);
    END;
  END LOOP;

  FOR r IN
    SELECT c.relname
      FROM pg_class c
     WHERE c.relnamespace = ns AND c.relkind IN ('r', 'p')
       AND (c.relname LIKE '\_zv\_ghost\_%'
         OR c.relname LIKE '\_zv\_old\_%'
         OR c.relname LIKE '\_zv\_changelog\_%')
       AND c.relname <> ALL (kept)
     -- Changelogs first: a copy's run is over once its changelog is gone.
     ORDER BY c.relname LIKE '\_zv\_changelog\_%' DESC, c.relname
  LOOP
    BEGIN
      EXECUTE format('DROP TABLE IF EXISTS %I', r.relname);
    EXCEPTION WHEN insufficient_privilege OR dependent_objects_still_exist THEN
      RAISE WARNING '122: cannot drop %, kept: %', r.relname, SQLERRM;
    END;
  END LOOP;

  -- Only a function no trigger runs any more.
  FOR r IN
    SELECT p.proname
      FROM pg_proc p
     WHERE p.pronamespace = ns AND p.pronargs = 0
       AND p.prorettype = 'trigger'::regtype
       AND p.proname LIKE '\_zv\_trg\_ghost\_%'
       AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid)
  LOOP
    BEGIN
      EXECUTE format('DROP FUNCTION IF EXISTS %I()', r.proname);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING '122: cannot drop function %(), kept: %', r.proname, SQLERRM;
    END;
  END LOOP;
END $$;

-- DOWN

-- Not reversed: what was dropped was the debris of runs that had already ended.
SELECT 1;
