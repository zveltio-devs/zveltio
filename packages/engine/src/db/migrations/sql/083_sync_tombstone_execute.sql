-- 083_sync_tombstone_execute.sql
--
-- `zveltio_sync_tombstone()` (032) is SECURITY DEFINER and EXECUTE on it stayed
-- with PUBLIC, the gap 082 closed for the Casbin triggers. It cannot be called
-- directly, but any role that owns a table can attach it, and CREATE TRIGGER
-- asks only for EXECUTE. Where boot cannot take TEMPORARY from PUBLIC
-- (lib/tenancy/temp-privilege.ts) the request, worker and extension roles own
-- temp tables: a temp table named `zvd_<collection>` with this trigger wrote,
-- as the owner, a tombstone for any row id in any unit, and sync pull told that
-- unit's clients to drop the row. `zveltio_worker`, which holds no grant on
-- zv_sync_tombstones, could do it too.
--
-- Firing a trigger checks no EXECUTE, so the triggers DDLManager puts on
-- collection tables keep working for every deleter; DDLManager attaches them as
-- the owner.
-- tests/harness/control-table-grants.test.ts.
--
-- Re-runnable: REVOKE of a privilege not held is a no-op.

REVOKE ALL ON FUNCTION public.zveltio_sync_tombstone() FROM PUBLIC;

-- DOWN

GRANT EXECUTE ON FUNCTION public.zveltio_sync_tombstone() TO PUBLIC;
