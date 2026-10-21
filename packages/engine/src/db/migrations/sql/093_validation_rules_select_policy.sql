-- 093_validation_rules_select_policy.sql
--
-- Since 092 a validation rule may belong to one tenant, and the request and
-- extension roles still read every row: `zveltio_rls` in tenant B selected
-- tenant A's rules (pattern, expression, error message). The engine's readers
-- filter on the column themselves; this is the line under them, for whatever
-- else reads the table as a request role.
--
-- One SELECT policy: an instance rule (NULL) binds every tenant and stays
-- readable to all, a tenant's rule only within that tenant's reach. Writes are
-- revoked from the request roles (ctx.internals.writeValidationRule writes as
-- the engine), so there is nothing else to police.
--
-- Not FORCE: the evaluator (lib/validation-engine.ts) reads on the pool as the
-- table owner with no tenant set, as do schema export/apply, tenant purge and
-- the migration guards; FORCE would hide every tenant rule from it and the
-- writes would pass unvalidated. And not named `tenant_isolation_*`: the boot
-- reconciler (reconcileExtensionTenantRLS) rewrites every such policy, moving
-- NULL rows to the default tenant and forcing the table.

ALTER TABLE zv_validation_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS validation_rules_instance_or_tenant ON zv_validation_rules;
CREATE POLICY validation_rules_instance_or_tenant ON zv_validation_rules FOR SELECT
  USING (tenant_id IS NULL OR zveltio_tenant_scope_ok(tenant_id));

-- DOWN
DROP POLICY IF EXISTS validation_rules_instance_or_tenant ON zv_validation_rules;
ALTER TABLE zv_validation_rules DISABLE ROW LEVEL SECURITY;
