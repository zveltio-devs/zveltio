-- 096_validation_rule_group_members.sql
--
-- A rule group (`developer/validation`'s `zvd_validation_rule_groups`) names its
-- members in `rule_ids`, a uuid[] no key can stand behind, and every path that
-- deletes a rule — ctx.internals.writeValidationRule, schema apply, a field
-- removed, a tenant's cascade — left the id there. The evaluator skips ids it
-- cannot find; the extension lists groups with SELECT *, so its UI showed
-- members that no longer exist. One trigger here covers every path, present
-- and future.
--
-- A group left with no members is kept: an empty group is one the API lets an
-- admin create, it combines nothing (lib/validation-engine.ts skips it), and it
-- is still theirs to see and delete. A dropped collection's groups already go
-- with it (DDLManager.dropInTransaction), as do a removed field's.
--
-- The table is the extension's and may be absent, now or later, so the trigger
-- asks for it on every delete; to_regclass returns NULL rather than raising.
-- SECURITY INVOKER, like 017's: only the engine's role deletes a rule (the
-- request roles hold no DML on it, control-table-grants.test.ts), the same role
-- that writes the groups. A role that could delete a rule but not update a
-- group gets the delete refused, not a dead member.

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

-- The members already dead.
DO $$
BEGIN
  IF to_regclass('public.zvd_validation_rule_groups') IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.zvd_validation_rule_groups g
     SET rule_ids = ARRAY(SELECT m FROM unnest(g.rule_ids) WITH ORDINALITY u(m, n)
                           WHERE EXISTS (SELECT 1 FROM zv_validation_rules r WHERE r.id = u.m)
                           ORDER BY u.n)
   WHERE EXISTS (SELECT 1 FROM unnest(g.rule_ids) m
                  WHERE NOT EXISTS (SELECT 1 FROM zv_validation_rules r WHERE r.id = m));
END $$;

-- DOWN
-- The dead members removed are not put back: each named a rule that is gone.
DROP TRIGGER IF EXISTS zv_forget_validation_rule_group_member ON zv_validation_rules;
DROP FUNCTION IF EXISTS zveltio_forget_validation_rule_group_member();
