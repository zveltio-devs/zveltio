-- 069_helper_search_path.sql
--
-- Two plpgsql helpers named relations unqualified and ran under the caller's
-- search_path, which searches pg_temp FIRST for relations — ahead of public and
-- even of pg_catalog. A temporary object left on a pooled backend by any role
-- still holding TEMPORARY (granted through PUBLIC until boot revokes it,
-- lib/tenancy/temp-privilege.ts) therefore answered for the real one:
--
--   zveltio_tenant_reach (057)       a temp `zv_tenant_users` widened a `self`
--                                    member's reach to every unit of the
--                                    instance, plan cache warm or not.
--   zveltio_collection_allows (058)  a temp view `pg_roles` naming the caller's
--                                    own role `zveltio_coll_exempt` let
--                                    `zveltio_worker` past every collection
--                                    grant (false -> true for delete).
--
-- Pinned the way 047 and 065 pin theirs: pg_catalog, public, then pg_temp LAST.
-- Bodies unchanged. Neither is ever inlined (plpgsql) and neither runs per row:
-- the reach runs once per request in the MATERIALIZED CTE of
-- `withTenantIsolation`, and policies wrap collection_allows in `(SELECT …)`,
-- an InitPlan. Measured on 6000 policed rows: call counts unchanged (reach 1
-- per request, collection_allows 1 per statement); reach 47.6–49.8 µs per call
-- before, 49.3–49.4 after; collection_allows 2.18 µs before, 2.55 after.
--
-- NOT pinned this way: the SQL helpers the policies call per row
-- (zveltio_tenant_write_ok, zveltio_tenant_scope_ok, …). A SET clause stops a
-- SQL function being inlined: measured, zveltio_tenant_scope_ok went from
-- inlined to 12000 calls and zveltio_tenant_write_ok to 2000 on the same reads.
--
-- Re-runnable: ALTER … SET replaces the value.

ALTER FUNCTION public.zveltio_tenant_reach(text, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.zveltio_collection_allows(text, text) SET search_path = pg_catalog, public, pg_temp;

-- DOWN

ALTER FUNCTION public.zveltio_collection_allows(text, text) RESET search_path;
ALTER FUNCTION public.zveltio_tenant_reach(text, text) RESET search_path;
