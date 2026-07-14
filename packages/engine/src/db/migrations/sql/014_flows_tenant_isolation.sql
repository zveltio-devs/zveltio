-- Migration 014: tenant isolation for flows (workflow automation) — route level.
--
-- zv_flows shipped as a flat GLOBAL table (no tenant_id, no RLS). routes/flows.ts
-- lists all flows and reaches them by id on the raw pool db, so in a multi-tenant
-- deployment any admin could read/patch/delete/run another tenant's flows by id
-- and enumerate the whole flow list (cross-tenant IDOR).
--
-- zv_flow_steps / zv_flow_runs / zv_flow_dlq are ALWAYS reached through a flow
-- (by flow_id), so scoping the flow (below + in the handlers, and by joining the
-- child reads to zv_flows) transitively protects them. They are intentionally NOT
-- given their own tenant_id here: the flow executor / scheduler write runs and DLQ
-- entries from a background context with no request tenant, so a DEFAULT-based
-- column would mis-tag those rows with the default tenant. Threading the flow's own
-- tenant_id through executeFlow (and adding columns there) is the separate executor
-- pass; this migration only closes the directly-exposed route surface.

ALTER TABLE zv_flows ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_flows SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_flows ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_flows_tenant ON zv_flows(tenant_id);
