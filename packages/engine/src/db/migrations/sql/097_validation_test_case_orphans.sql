-- 097_validation_test_case_orphans.sql
--
-- `developer/validation`'s test cases (`zvd_validation_test_cases`) name their
-- rule by `rule_id` with no key behind it, and no path that deletes a rule —
-- the extension's DELETE routes, schema apply, a field removed, a tenant's
-- cascade — touched them: they outlived the rule, unreachable (every route
-- reads them through the rule) and kept forever. 096's trigger now removes them
-- too, so it is renamed for what it does: zveltio_forget_validation_rule.
--
-- The table is the extension's tenant-scoped one (its 002: FORCE RLS, a
-- `tenant_isolation_*` policy), and a test case of an instance rule may be any
-- tenant's. The trigger runs as the deleting role, the engine's, which FORCE
-- binds too (scripts/bootstrap-db-role.sh: NOSUPERUSER NOBYPASSRLS), inside the
-- request's tenant — so a plain DELETE removed that tenant's test cases and
-- skipped every other's in silence. It reaches every tenant for that one
-- statement, as withEveryTenant does: `zveltio.visible_tenants` set to every
-- `zv_tenants` id, then put back (a failed DELETE aborts the statement, whose
-- rollback restores it). Not a SET clause on the function: the owner role may
-- not attach a placeholder parameter to one (42501), only a superuser. Only
-- the engine deletes a rule (control-table-grants.test.ts), and a test case of
-- a rule that is gone tests nothing, whoever wrote it. A row whose tenant has no
-- `zv_tenants` row stays invisible here, as everywhere: tenant purge owns those.

CREATE OR REPLACE FUNCTION zveltio_forget_validation_rule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev text;
BEGIN
  IF to_regclass('public.zvd_validation_rule_groups') IS NOT NULL THEN
    UPDATE public.zvd_validation_rule_groups
       SET rule_ids = array_remove(rule_ids, OLD.id)
     WHERE OLD.id = ANY(rule_ids);
  END IF;
  IF to_regclass('public.zvd_validation_test_cases') IS NOT NULL THEN
    prev := current_setting('zveltio.visible_tenants', true);
    PERFORM set_config('zveltio.visible_tenants',
      coalesce((SELECT string_agg(id::text, ',') FROM public.zv_tenants), ''), true);
    DELETE FROM public.zvd_validation_test_cases WHERE rule_id = OLD.id;
    PERFORM set_config('zveltio.visible_tenants', coalesce(prev, ''), true);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS zv_forget_validation_rule_group_member ON zv_validation_rules;
DROP FUNCTION IF EXISTS zveltio_forget_validation_rule_group_member();
DROP TRIGGER IF EXISTS zv_forget_validation_rule ON zv_validation_rules;
CREATE TRIGGER zv_forget_validation_rule
  AFTER DELETE ON zv_validation_rules
  FOR EACH ROW EXECUTE FUNCTION zveltio_forget_validation_rule();

-- The test cases already orphaned, in every tenant.
DO $$
BEGIN
  IF to_regclass('public.zvd_validation_test_cases') IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('zveltio.visible_tenants',
    coalesce((SELECT string_agg(id::text, ',') FROM zv_tenants), ''), true);
  DELETE FROM public.zvd_validation_test_cases t
   WHERE NOT EXISTS (SELECT 1 FROM zv_validation_rules r WHERE r.id = t.rule_id);
  PERFORM set_config('zveltio.visible_tenants', '', true);
END $$;

-- DOWN
-- 096's trigger, verbatim. The orphaned test cases deleted do not come back.
DROP TRIGGER IF EXISTS zv_forget_validation_rule ON zv_validation_rules;
DROP FUNCTION IF EXISTS zveltio_forget_validation_rule();
CREATE OR REPLACE FUNCTION zveltio_forget_validation_rule_group_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.zvd_validation_rule_groups') IS NOT NULL THEN
    UPDATE public.zvd_validation_rule_groups
       SET rule_ids = array_remove(rule_ids, OLD.id)
     WHERE OLD.id = ANY(rule_ids);
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS zv_forget_validation_rule_group_member ON zv_validation_rules;
CREATE TRIGGER zv_forget_validation_rule_group_member
  AFTER DELETE ON zv_validation_rules
  FOR EACH ROW EXECUTE FUNCTION zveltio_forget_validation_rule_group_member();
