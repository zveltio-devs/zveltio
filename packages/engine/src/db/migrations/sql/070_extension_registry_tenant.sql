-- Extension registry: per-tenant activation support
-- tenant_id NULL  = global (available to all tenants / instance-wide)
-- tenant_id SET   = enabled only for that specific tenant

ALTER TABLE zv_extension_registry
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_zv_ext_registry_tenant
  ON zv_extension_registry(tenant_id);

-- Composite index for the common query pattern:
-- WHERE (tenant_id IS NULL OR tenant_id = $1) AND is_enabled = true
CREATE INDEX IF NOT EXISTS idx_zv_ext_registry_tenant_enabled
  ON zv_extension_registry(tenant_id, is_enabled);
