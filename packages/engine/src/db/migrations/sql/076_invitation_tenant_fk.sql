-- 076_invitation_tenant_fk.sql
--
-- `zv_invitations.tenant_id` named a tenant with no foreign key (A10): an
-- invitation could be written for a tenant that does not exist, and a bare
-- `DELETE FROM zv_tenants` left the tenant's invitations behind. Tenant purge
-- (`lib/tenancy/tenant-purge.ts`) deletes them first, so ON DELETE CASCADE only
-- covers a delete that skips it.
--
-- Added NOT VALID, then validated when every existing row has its tenant: an
-- orphan left by an older bare delete keeps the key unvalidated (new rows are
-- still checked) instead of failing the migration or deleting rows here.

ALTER TABLE zv_invitations DROP CONSTRAINT IF EXISTS zv_invitations_tenant_id_fkey;
ALTER TABLE zv_invitations
  ADD CONSTRAINT zv_invitations_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES zv_tenants(id) ON DELETE CASCADE NOT VALID;

DO $$
BEGIN
  ALTER TABLE zv_invitations VALIDATE CONSTRAINT zv_invitations_tenant_id_fkey;
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'zv_invitations holds invitations of deleted tenants; the key stays NOT VALID';
END $$;

-- DOWN
ALTER TABLE zv_invitations DROP CONSTRAINT IF EXISTS zv_invitations_tenant_id_fkey;
