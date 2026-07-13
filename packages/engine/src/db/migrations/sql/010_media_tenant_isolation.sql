-- Migration 010: tenant isolation for media files + folders.
--
-- zv_media_files / zv_media_folders shipped as flat GLOBAL tables (no tenant_id,
-- no RLS). routes/storage.ts and routes/media.ts query them by id/folder_id only,
-- so in a multi-tenant deployment any authenticated user could list/view/download
-- (signed URL)/transform/DELETE another tenant's media by id — a cross-tenant IDOR.
--
-- Add a tenant_id scoped exactly like the RLS tables' default: NULLIF-guarded so a
-- blank `zveltio.current_tenant` GUC (single-tenant / no context) falls back to the
-- default tenant instead of crashing on ''::uuid. Existing rows backfill to the
-- default tenant. The route handlers additionally filter every read/delete by the
-- request's tenant id (explicit scoping — no FORCE RLS, so background media jobs
-- that run without a tenant GUC are unaffected).

ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_media_files
  SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
  WHERE tenant_id IS NULL;
ALTER TABLE zv_media_files
  ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
           '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_tenant ON zv_media_files(tenant_id);

ALTER TABLE zv_media_folders ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_media_folders
  SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
  WHERE tenant_id IS NULL;
ALTER TABLE zv_media_folders
  ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
           '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_media_folders_tenant ON zv_media_folders(tenant_id);
