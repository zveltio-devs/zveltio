-- 027_flows_rls.sql
--
-- `zv_flows` goes under the tenant policy every tenant table has.
--
-- It got `tenant_id` in 001 and no policy. What kept one firm out of another's
-- flows was the `where tenant_id = tenantOf(c)` each `/api/flows` handler
-- remembered; a whitelisted RPC function, or any reader that forgets, saw every
-- firm's flows and their trigger configuration.
--
-- Every reader ran outside a tenant transaction, where a policed table answers
-- for the default firm only on a non-superuser database, so each moves with it:
--   * `/api/flows` runs on the pool; each flow query now runs in the tenant's
--     `withTenantIsolation`.
--   * The scheduler claims every firm's due flows in ONE transaction; it now
--     publishes every firm as its reach (`withEveryTenant`), the way god's reach
--     is published, and makes each write as the row's own firm.
--   * The executor looks up which firm a flow runs as through the same reach.
--   * The record hook looks up the writing firm's flows inside that firm.
-- No extension reads the table (`ai` only relaxes its CHECK constraint).
--
-- Its children (`zv_flow_steps`, `zv_flow_runs`, `zv_flow_dlq`) carry no
-- `tenant_id` and stay isolated by the parent lookup, as before.

-- A NULL tenant_id is invisible to everyone under the policy. 001 backfilled the
-- column already; this catches a row written with an explicit NULL.
UPDATE zv_flows SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;

ALTER TABLE zv_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE zv_flows FORCE ROW LEVEL SECURITY;

-- The shape the boot reconciler gives every `tenant_isolation_*` policy
-- (005: the `(SELECT …)` InitPlan; 004: writes to the own node only).
DROP POLICY IF EXISTS tenant_isolation_zv_flows ON zv_flows;
CREATE POLICY tenant_isolation_zv_flows ON zv_flows AS PERMISSIVE FOR ALL TO public
  USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))
  WITH CHECK (zveltio_tenant_write_ok(tenant_id));

-- DOWN

DROP POLICY IF EXISTS tenant_isolation_zv_flows ON zv_flows;
ALTER TABLE zv_flows NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_flows DISABLE ROW LEVEL SECURITY;
