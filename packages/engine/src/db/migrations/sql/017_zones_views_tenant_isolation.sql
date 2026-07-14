-- Migration 017: complete tenant isolation for the zones/pages/views cluster.
--
-- zvd_zones / zvd_pages / zvd_views already carry tenant_id (added + backfilled
-- in 007_default_tenant.sql) but routes/zones.ts queried them by slug/id/zone_id
-- with NO tenant filter, so:
--   - list showed every tenant's zones/views,
--   - GET/PUT/DELETE zone-by-slug, page-by-(zone,slug), view-by-id and the
--     reorder endpoints reached across tenants, and
--   - the public render path resolved each view's records from zvd_<collection>
--     with no tenant scope → served another tenant's business data.
-- The route now scopes every access by tenantId(c). This migration:
--   1. gives zvd_page_views its own tenant_id (it had none — the reorder handler
--      updates it by raw id), and
--   2. adds the NULLIF-guarded session default to all four tables so any insert
--      that omits tenant_id still lands in the request tenant.

ALTER TABLE zvd_page_views ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zvd_page_views SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_zvd_page_views_tenant ON zvd_page_views(tenant_id);

ALTER TABLE zvd_zones ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
ALTER TABLE zvd_pages ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
ALTER TABLE zvd_views ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
ALTER TABLE zvd_page_views ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
