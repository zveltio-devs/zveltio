-- 082_casbin_trigger_functions_execute.sql
--
-- The three Casbin membership triggers run as their owner since 080, and
-- EXECUTE on them stayed with PUBLIC. A function declared RETURNS trigger cannot
-- be called directly ("trigger functions can only be called as triggers"), but
-- any role that can own a table can attach one to it, and CREATE TRIGGER asks
-- only for EXECUTE. Where boot cannot take TEMPORARY from PUBLIC
-- (lib/tenancy/temp-privilege.ts), `zveltio_rls` and the extension roles own
-- temp tables: a temp table firing zveltio_drop_deleted_user_grants() on
-- DELETE wiped any subject's grants, `god` included, and one firing
-- zveltio_grant_member_role() on INSERT wrote `member` on '*' for any id.
-- Firing a trigger checks no EXECUTE, so the triggers on "user" and
-- zv_tenant_users keep working for every writer.
--
-- search_path is already pinned by 080.
-- tests/harness/control-table-grants.test.ts.
--
-- Re-runnable: REVOKE of a privilege not held is a no-op.

REVOKE ALL ON FUNCTION public.zveltio_grant_member_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zveltio_drop_deleted_user_grants() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zveltio_drop_removed_member_grants() FROM PUBLIC;

-- DOWN

GRANT EXECUTE ON FUNCTION public.zveltio_drop_removed_member_grants() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.zveltio_drop_deleted_user_grants() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.zveltio_grant_member_role() TO PUBLIC;
