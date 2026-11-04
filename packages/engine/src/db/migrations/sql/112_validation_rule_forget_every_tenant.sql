-- 112_validation_rule_forget_every_tenant.sql
--
-- Since 111 the engine owns `zvd_validation_test_cases`, so boot gives it the
-- engine's tenant policies, among them the RESTRICTIVE `tenant_own_node_delete`
-- (tenant-manager.ts, B09): a DELETE inside a tenant's request removes only
-- that tenant's rows; with no tenant set it stands aside, for the engine's own
-- cross-firm work. 097's trigger widened `zveltio.visible_tenants` to every
-- firm but left `zveltio.current_tenant` set, so an instance rule deleted from
-- one tenant's request took only that tenant's test cases and left every other
-- firm's behind — the orphans 097 was written to remove (measured on the
-- non-superuser harness lane: validation-test-case-orphans.test.ts).
--
-- The trigger now clears `zveltio.current_tenant` for its one DELETE too, and
-- puts both settings back. Only the engine deletes a rule
-- (control-table-grants.test.ts), and a test case of a rule that is gone tests
-- nothing, whoever wrote it.

CREATE OR REPLACE FUNCTION zveltio_forget_validation_rule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev text;
  prev_tenant text;
BEGIN
  UPDATE public.zvd_validation_rule_groups
     SET rule_ids = array_remove(rule_ids, OLD.id)
   WHERE OLD.id = ANY(rule_ids);
  prev := current_setting('zveltio.visible_tenants', true);
  prev_tenant := current_setting('zveltio.current_tenant', true);
  PERFORM set_config('zveltio.visible_tenants',
    coalesce((SELECT string_agg(id::text, ',') FROM public.zv_tenants), ''), true);
  PERFORM set_config('zveltio.current_tenant', '', true);
  DELETE FROM public.zvd_validation_test_cases WHERE rule_id = OLD.id;
  PERFORM set_config('zveltio.visible_tenants', coalesce(prev, ''), true);
  PERFORM set_config('zveltio.current_tenant', coalesce(prev_tenant, ''), true);
  RETURN NULL;
END;
$$;

-- DOWN

-- 097's body, which still probes for the tables the extension owned.
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
