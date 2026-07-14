-- Migration 012: tenant isolation for media tags (completes the media cluster
-- started in 010, which covered zv_media_files + zv_media_folders).
--
-- zv_media_tags / zv_media_file_tags had no tenant_id, so routes/media.ts listed
-- ALL tenants' tags, and PUT/DELETE /tags/:id could rename/delete another tenant's
-- tags by id (cross-tenant). Add tenant_id (NULLIF-guarded default) + backfill; the
-- handlers scope every tag read/write by the request tenant.

ALTER TABLE zv_media_tags ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_media_tags SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_media_tags ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_media_tags_tenant ON zv_media_tags(tenant_id);
-- Tag names were GLOBALLY unique — under multi-tenancy each tenant needs its own
-- name namespace (otherwise one tenant's tag name blocks another's + leaks existence).
ALTER TABLE zv_media_tags DROP CONSTRAINT IF EXISTS zv_media_tags_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS zv_media_tags_tenant_name_key ON zv_media_tags(tenant_id, name);

ALTER TABLE zv_media_file_tags ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_media_file_tags SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_media_file_tags ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_media_file_tags_tenant ON zv_media_file_tags(tenant_id);
