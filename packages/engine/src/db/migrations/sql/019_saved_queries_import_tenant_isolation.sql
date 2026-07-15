-- Migration 019: tenant isolation for saved queries + import logs
-- (closes the engine-route tenant-isolation campaign).
--
-- zv_saved_queries: routes scoped reads by `created_by = user OR is_shared`, but
--   `is_shared` was GLOBAL — a query shared in tenant B was visible to tenant A.
--   Sharing must be per-ORGANIZATION, so scope every access by tenant_id and let
--   is_shared mean "shared within this tenant".
-- zv_import_logs: the list handler only narrowed to `created_by` for non-admins,
--   so a tenant admin saw EVERY tenant's import logs (filenames, collections,
--   error rows), and the status-update handlers reached a log by raw id.
-- Add tenant_id (NULLIF-guarded default) + backfill; handlers scope by tenant.

ALTER TABLE zv_saved_queries ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_saved_queries SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_saved_queries ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_saved_queries_tenant ON zv_saved_queries(tenant_id);

ALTER TABLE zv_import_logs ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_import_logs SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_import_logs ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_import_logs_tenant ON zv_import_logs(tenant_id);
