-- Migration 021: tenant isolation for API keys + invitations.
--
-- zv_api_keys: the management routes (admin.ts + admin/system-routes.ts) list,
--   revoke (DELETE /:id) and patch keys by raw id against the un-scoped pool, so
--   a tenant admin saw EVERY tenant's keys and could revoke/patch another
--   tenant's key by id (cross-tenant IDOR). We add tenant_id and scope every
--   management handler by the request tenant.
-- zv_invitations: created per-tenant (users.ts) but the accept/lookup path
--   reaches an invite purely by token; add tenant_id so an accepted invite lands
--   the new member in the inviting tenant rather than the default one.
--
-- NOTE: no DB-level RLS here on purpose. zv_api_keys is read by the API-key auth
--   guard BEFORE tenant resolution runs (the GUC is still unset at that point);
--   a strict RLS policy would return zero rows and break API-key auth entirely.
--   Isolation is enforced at the route layer, mirroring migration 019.

ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_api_keys SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_api_keys ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_api_keys_tenant ON zv_api_keys(tenant_id);

ALTER TABLE zv_invitations ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_invitations SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_invitations ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_invitations_tenant ON zv_invitations(tenant_id);
