-- 090_validation_rules_cel_down_guard.sql
--
-- Nothing to apply. This file exists for its DOWN, which guards 087's.
--
-- 087's UP rewrote `and` / `or` to `&&` / `||`, and left as written every rule
-- that already had a `||`: in expr-eval that is string concatenation. 087's DOWN
-- spells every `||` back as ` or `, so rolling it back turned such a rule's
-- concatenation into a logical `or` under the older engine — `value || '-x' ==
-- 'a-x'` became `value or '-x' == 'a-x'`, which accepts any non-empty value —
-- without a word. Measured with `zveltio rollback --to 86`.
--
-- After 087 has run, a `||` it wrote and a `||` it left are the same text: which
-- one a rule holds is not recorded anywhere. A rule created after 087 ran was
-- written for CEL, so its `||` is logical and 087's DOWN is right about it. A
-- rule created before may be either, and this refuses the rollback while one is
-- left, naming it, rather than guess. Disabling it instead would quietly stop
-- the validation it stands for.
--
-- The refusal applies only to a rollback that reaches 087: the runner tells the
-- DOWN where it stops (`zveltio.rollback_target`), and a DOWN run without that
-- setting is treated as one that does.

SELECT 1;

-- DOWN
-- The conditions are 087's DOWN, narrowed to a `||` outside a literal: a `&&`
-- was never expr-eval, so 087 wrote every one of them.
DO $$
DECLARE
  ids text;
BEGIN
  IF COALESCE(NULLIF(current_setting('zveltio.rollback_target', true), '')::int, 0) >= 87 THEN
    RETURN;
  END IF;
  SELECT string_agg(r.id::text, ', ' ORDER BY r.id) INTO ids
    FROM zv_validation_rules r
   WHERE r.rule_type IN ('custom', 'nlp')
     AND r.rule_config->>'expression' !~ '\\'
     AND regexp_replace(r.rule_config->>'expression', '''[^'']*''|"[^"]*"', '', 'g') ~ '\|\|'
     AND NOT EXISTS (
           SELECT 1
             FROM regexp_matches(r.rule_config->>'expression', '''[^'']*''|"[^"]*"', 'g') AS lit(m)
            WHERE lit.m[1] ~ '&&|\|\|')
     AND r.created_at <= COALESCE(
           (SELECT applied_at FROM zv_schema_versions WHERE version = 87), 'infinity');
  IF ids IS NOT NULL THEN
    RAISE EXCEPTION 'rolling back 087 would turn `||` into `or` in validation rules older than it (%), and in expr-eval `||` concatenates strings: 087 left a rule that concatenated as written and rewrote `or` to `||` in others, and which is which is not recorded. Rewrite each without `||` (a logical one as `or`) or delete it, then roll back again.', ids;
  END IF;
END $$;
