-- 031_media_shares_tenant_backfill.sql
--
-- The share links 023 left without a firm.
--
-- 023 copied each file's (or folder's) `tenant_id` onto its shares BEFORE it
-- moved files and folders with a NULL `tenant_id` to the default tenant, so the
-- shares of exactly those stayed NULL. `/share/:token` (storage/cloud) enters
-- the share's firm to read what it shares; with NULL it reads on the pool with
-- no tenant, which for a plain engine role answers "File has been deleted"
-- wherever `zveltio.fail_closed_tenant` is on.
--
-- One tenant at a time with that tenant published, as 023 does: where the
-- migration runs as a plain owner role under FORCE RLS, a join with no tenant
-- set sees the default tenant's rows only.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM zv_tenants LOOP
    PERFORM set_config('zveltio.current_tenant', t::text, true);
    UPDATE zv_media_shares s SET tenant_id = f.tenant_id
      FROM zv_media_files f
     WHERE s.tenant_id IS NULL AND f.id = s.file_id AND f.tenant_id = t;
    UPDATE zv_media_shares s SET tenant_id = fo.tenant_id
      FROM zv_media_folders fo
     WHERE s.tenant_id IS NULL AND fo.id = s.folder_id AND fo.tenant_id = t;
  END LOOP;
  PERFORM set_config('zveltio.current_tenant', '', true);
END $$;

-- DOWN

-- Deliberately a no-op: which shares were NULL is not recorded, and a NULL
-- firm is the defect this repairs.
SELECT 1;
