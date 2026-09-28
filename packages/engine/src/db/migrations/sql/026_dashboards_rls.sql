-- 026_dashboards_rls.sql
--
-- `zv_dashboards` goes under the tenant policy every tenant table has.
--
-- It got `tenant_id` in 001 and no policy. What kept one firm out of another's
-- dashboards was the `where tenant_id = tenantOf(c)` each `/api/insights`
-- handler remembered; a whitelisted RPC function, or any handler that forgets,
-- saw every firm's dashboards, public ones included.
--
-- `/api/insights` runs on the pool, not the request transaction (it opens read-
-- only transactions of its own), and on a non-superuser database a policed table
-- read there answers for the default tenant only. The router now runs every
-- dashboard query inside the tenant's `withTenantIsolation`, so nothing loses
-- rows it needs. No other reader exists, in the engine or in the extensions.
--
-- Its children (`zv_panels`, `zvd_dashboard_shares`, `zvd_panel_cache`,
-- `zvd_dashboard_subscriptions`) carry no `tenant_id` and stay isolated by the
-- parent lookup, as before.

-- A NULL tenant_id is invisible to everyone under the policy. 001 backfilled the
-- column already; this catches a row written with an explicit NULL.
UPDATE zv_dashboards SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;

ALTER TABLE zv_dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE zv_dashboards FORCE ROW LEVEL SECURITY;

-- The shape the boot reconciler gives every `tenant_isolation_*` policy
-- (005: the `(SELECT …)` InitPlan; 004: writes to the own node only).
DROP POLICY IF EXISTS tenant_isolation_zv_dashboards ON zv_dashboards;
CREATE POLICY tenant_isolation_zv_dashboards ON zv_dashboards AS PERMISSIVE FOR ALL TO public
  USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))
  WITH CHECK (zveltio_tenant_write_ok(tenant_id));

-- DOWN

DROP POLICY IF EXISTS tenant_isolation_zv_dashboards ON zv_dashboards;
ALTER TABLE zv_dashboards NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_dashboards DISABLE ROW LEVEL SECURITY;
