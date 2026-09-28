-- 029_environments_rls.sql
--
-- `zv_environments` goes under the tenant policy every tenant table has.
--
-- 001 gave it `tenant_id` and no policy, and `quality-gates/tenant-boundary.json`
-- justified that with "`resolveEnvironment()` runs before the tenant transaction,
-- so a policy breaks tenant resolution". It does not: the environment is looked
-- up AFTER the tenant is resolved and by that tenant's id — nothing reads this
-- table before the tenant is known. What kept one firm out of another's
-- environments (schema names, settings) was the `where tenant_id = …` each of
-- the three readers remembered; a whitelisted RPC function saw every firm's.
--
-- All three readers ran on the pool, where a policed table answers for the
-- default firm only on a non-superuser database, so each moves into its firm:
--   * `tenantMiddleware` resolves the request's environment inside the request
--     transaction, or — on a TXN_SKIP_PREFIXES path — a short one of its own.
--   * `getTenantEnvironments` / `provisionEnvironment` (`/api/tenants`) read and
--     write inside the named firm's `withTenantIsolation`.
-- No extension reads the table.

-- `tenant_id` is NOT NULL since 001, so no row is left invisible to everyone.
ALTER TABLE zv_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE zv_environments FORCE ROW LEVEL SECURITY;

-- The shape the boot reconciler gives every `tenant_isolation_*` policy
-- (005: the `(SELECT …)` InitPlan; 004: writes to the own node only).
DROP POLICY IF EXISTS tenant_isolation_zv_environments ON zv_environments;
CREATE POLICY tenant_isolation_zv_environments ON zv_environments AS PERMISSIVE FOR ALL TO public
  USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))
  WITH CHECK (zveltio_tenant_write_ok(tenant_id));

-- DOWN

DROP POLICY IF EXISTS tenant_isolation_zv_environments ON zv_environments;
ALTER TABLE zv_environments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_environments DISABLE ROW LEVEL SECURITY;
