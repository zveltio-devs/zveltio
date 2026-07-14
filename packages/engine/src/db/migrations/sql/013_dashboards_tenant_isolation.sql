-- Migration 013: tenant isolation for insights dashboards.
--
-- zv_dashboards had no tenant_id, and routes/insights.ts lists `WHERE
-- d.is_public = true OR created_by = me OR shared`, so a PUBLIC dashboard was
-- visible to authenticated users of EVERY tenant (cross-tenant leak), and the
-- by-id read/update/delete/share handlers found dashboards across tenants.
-- Panels and shares are always reached through a dashboard lookup, so scoping the
-- dashboard (below + in the handler) transitively protects them.

ALTER TABLE zv_dashboards ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_dashboards SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_dashboards ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_dashboards_tenant ON zv_dashboards(tenant_id);
