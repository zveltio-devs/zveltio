-- 080_casbin_triggers_definer.sql
--
-- `zveltio_rls` no longer writes the Casbin table. It held DML on it so that
-- these three triggers, SECURITY INVOKER since 017, 034 and 059, could keep
-- `zvd_permissions` in step with "user" and `zv_tenant_users` whoever wrote
-- those. That grant also put a `god` grant one SQL-analyzer miss away from
-- every statement that falls back to the request role (inline `ctx.db` with no
-- extension role, the worker bridge's last fallback). Boot now takes
-- INSERT/UPDATE/DELETE on it back from `zveltio_rls` (ensureRlsEnforcementRole),
-- so the triggers run as their owner instead. Each writes only rows keyed by the
-- row that fired it, which the writer could already create or delete.
--
-- search_path pinned as 065 and 069 pin theirs: pg_temp last, so a temporary
-- `zvd_permissions` cannot stand in for the real one under the owner's rights.
--
-- Re-runnable: ALTER … SECURITY DEFINER / SET replace the value.

ALTER FUNCTION public.zveltio_grant_member_role()
  SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.zveltio_drop_deleted_user_grants()
  SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.zveltio_drop_removed_member_grants()
  SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- DOWN

ALTER FUNCTION public.zveltio_drop_removed_member_grants() SECURITY INVOKER RESET search_path;
ALTER FUNCTION public.zveltio_drop_deleted_user_grants() SECURITY INVOKER RESET search_path;
ALTER FUNCTION public.zveltio_grant_member_role() SECURITY INVOKER RESET search_path;
