-- 092_validation_rules_per_tenant.sql
--
-- A validation rule may belong to one tenant: `tenant_id` NULL is an instance
-- rule (every tenant's writes answer to it, as before), a tenant id is that
-- tenant's own rule, ANDed on top. Tighten-only: a tenant rule never joins a
-- rule group and nothing lets a tenant switch an instance rule off for itself
-- (lib/validation-engine.ts). The evaluator filters on this column itself;
-- the table keeps no RLS, so the request roles still read every row and write
-- none (writes: ctx.internals.writeValidationRule, as the engine).
--
-- Tenant purge deletes the rows by the column (lib/tenancy/tenant-purge.ts);
-- the cascade covers a bare delete. The key validates at once: every existing
-- row is an instance rule.

ALTER TABLE zv_validation_rules ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE zv_validation_rules DROP CONSTRAINT IF EXISTS zv_validation_rules_tenant_id_fkey;
ALTER TABLE zv_validation_rules
  ADD CONSTRAINT zv_validation_rules_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES zv_tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE zv_validation_rules VALIDATE CONSTRAINT zv_validation_rules_tenant_id_fkey;
-- For the purge and the cascade; instance rules (NULL) stay out of it.
CREATE INDEX IF NOT EXISTS idx_validation_rules_tenant
  ON zv_validation_rules (tenant_id) WHERE tenant_id IS NOT NULL;

-- DOWN
-- Refused while a tenant rule exists. Dropping the column would turn each into
-- an instance rule refusing every tenant's writes, and deleting them would
-- quietly stop the validation each tenant put in place.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM zv_validation_rules WHERE tenant_id IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'rolling back 092 would turn % tenant validation rule(s) into rules every tenant answers to. Delete them (DELETE FROM zv_validation_rules WHERE tenant_id IS NOT NULL) and roll back again.', n;
  END IF;
END $$;
DROP INDEX IF EXISTS idx_validation_rules_tenant;
ALTER TABLE zv_validation_rules DROP CONSTRAINT IF EXISTS zv_validation_rules_tenant_id_fkey;
ALTER TABLE zv_validation_rules DROP COLUMN IF EXISTS tenant_id;
