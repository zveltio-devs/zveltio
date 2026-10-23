-- 098_validation_rule_instance_key.sql
--
-- An instance rule (`tenant_id` NULL) is one per (collection, field, rule type,
-- config): that key is how the schema artifact names it (plan.ts's validation
-- id) and how a rule group's member names it in a file. Nothing held it, so two
-- identical instance rules exported as two entries under one plan id, the plan
-- kept one, and apply refused any group naming that key ("more than one
-- instance rule"). Tenant rules stay out: no file carries them and no group
-- names them, they only add to the instance rules.
--
-- The config is indexed by its jsonb hash, not by value: a CEL expression of a
-- few kB is over btree's 2704-byte row limit, and the hash agrees with jsonb
-- equality (1.0 = 1), which is what apply's lookup compares.
--
-- Existing duplicates: one survives — an active one before an inactive one (a
-- check that ran keeps running), then the oldest. The groups naming a
-- duplicate name the survivor instead, once, in the same place; its test cases
-- (`developer/validation`'s, FORCE RLS, any tenant's) move to the survivor,
-- reached in every tenant as 097 reaches them. Then the duplicates go, and
-- 097's trigger finds nothing left to forget.

DO $$
DECLARE
  dups uuid[];
  keeps uuid[];
BEGIN
  SELECT array_agg(id), array_agg(keep) INTO dups, keeps
    FROM (SELECT id, first_value(id) OVER (
                       PARTITION BY collection, field_name, rule_type, rule_config
                       ORDER BY is_active DESC, created_at, id) AS keep
            FROM zv_validation_rules
           WHERE tenant_id IS NULL) r
   WHERE id <> keep;
  IF dups IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('zveltio.visible_tenants',
    coalesce((SELECT string_agg(id::text, ',') FROM zv_tenants), ''), true);
  IF to_regclass('public.zvd_validation_rule_groups') IS NOT NULL THEN
    UPDATE public.zvd_validation_rule_groups g
       SET rule_ids = ARRAY(SELECT k FROM (SELECT coalesce(d.keep, u.m) AS k, min(u.n) AS n
                                             FROM unnest(g.rule_ids) WITH ORDINALITY u(m, n)
                                             LEFT JOIN unnest(dups, keeps) d(id, keep) ON d.id = u.m
                                            GROUP BY 1) x
                             ORDER BY x.n)
     WHERE g.rule_ids && dups;
  END IF;
  IF to_regclass('public.zvd_validation_test_cases') IS NOT NULL THEN
    UPDATE public.zvd_validation_test_cases t
       SET rule_id = d.keep
      FROM unnest(dups, keeps) d(id, keep)
     WHERE t.rule_id = d.id;
  END IF;
  DELETE FROM zv_validation_rules WHERE id = ANY(dups);
  PERFORM set_config('zveltio.visible_tenants', '', true);
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS zv_validation_rules_instance_key
  ON zv_validation_rules (collection, field_name, rule_type, jsonb_hash_extended(rule_config, 0))
  WHERE tenant_id IS NULL;

-- DOWN
-- The duplicates deleted do not come back: each repeated its survivor.
DROP INDEX IF EXISTS zv_validation_rules_instance_key;
