-- 091_validation_rule_groups_instance_wide.sql
--
-- `zvd_validation_rule_groups` (the `developer/validation` extension's table)
-- leaves tenancy, like `zv_validation_rules` beside it: a group decides how the
-- rules on a field combine (AND / OR), the rules are instance-wide, and the
-- evaluator caches groups per collection (lib/validation-engine.ts), so one
-- tenant's group was served to the next tenant's writes for up to a minute.
-- Writes now go through `ctx.internals.writeValidationRuleGroup` (instance
-- admin, as the engine); the request and extension roles only read it.
--
-- Rows are kept. A name is now unique per collection, so where several rows
-- share (collection, name) one survives and the rest are deleted, ranked by:
--   1. the default tenant's row (00000000-0000-0000-0000-000000000001),
--   2. then a NULL tenant_id (legacy rows from before the extension's 002),
--   3. then any other tenant's,
-- ties broken by the oldest created_at, then the lowest id. Deterministic, and
-- the same rule picks the survivor of a clash inside one tenant.
--
-- The table is absent unless the extension is installed; nothing to do then.
-- The extension's own 004 repeats this for an install made after this ran (its
-- 002 adds the tenant column again).

DO $$
DECLARE
  pol text;
BEGIN
  IF to_regclass('public.zvd_validation_rule_groups') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.zvd_validation_rule_groups'::regclass
                AND attname = 'tenant_id' AND NOT attisdropped) THEN
    -- First, so the DELETE sees every tenant's rows (FORCE binds the owner too);
    -- every policy, not only the template's, since one on tenant_id blocks the drop.
    FOR pol IN SELECT policyname FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'zvd_validation_rule_groups' LOOP
      EXECUTE format('DROP POLICY %I ON public.zvd_validation_rule_groups', pol);
    END LOOP;
    ALTER TABLE zvd_validation_rule_groups NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE zvd_validation_rule_groups DISABLE ROW LEVEL SECURITY;
    DELETE FROM zvd_validation_rule_groups g
     USING (SELECT id,
                   row_number() OVER (
                     PARTITION BY collection, name
                     ORDER BY CASE
                                WHEN tenant_id = '00000000-0000-0000-0000-000000000001'::uuid THEN 0
                                WHEN tenant_id IS NULL THEN 1
                                ELSE 2
                              END,
                              created_at, id) AS rank
              FROM zvd_validation_rule_groups) r
     WHERE g.id = r.id AND r.rank > 1;
    -- Its indexes go with it.
    ALTER TABLE zvd_validation_rule_groups DROP COLUMN tenant_id;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS zvd_validation_rule_groups_collection_name
    ON zvd_validation_rule_groups (collection, name);
END $$;

-- DOWN
-- The extension's 002 shape: every row goes to the default tenant (the deleted
-- clash losers do not come back).
DO $$
BEGIN
  IF to_regclass('public.zvd_validation_rule_groups') IS NULL THEN
    RETURN;
  END IF;
  DROP INDEX IF EXISTS zvd_validation_rule_groups_collection_name;
  ALTER TABLE zvd_validation_rule_groups ADD COLUMN IF NOT EXISTS tenant_id UUID;
  UPDATE zvd_validation_rule_groups
     SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
   WHERE tenant_id IS NULL;
  ALTER TABLE zvd_validation_rule_groups ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
  CREATE INDEX IF NOT EXISTS idx_zvd_validation_rule_groups_tenant
    ON zvd_validation_rule_groups (tenant_id);
  ALTER TABLE zvd_validation_rule_groups ENABLE ROW LEVEL SECURITY;
  ALTER TABLE zvd_validation_rule_groups FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_zvd_validation_rule_groups ON zvd_validation_rule_groups;
  CREATE POLICY tenant_isolation_zvd_validation_rule_groups ON zvd_validation_rule_groups
    USING (zveltio_tenant_scope_ok(tenant_id))
    WITH CHECK (zveltio_tenant_scope_ok(tenant_id));
END $$;
