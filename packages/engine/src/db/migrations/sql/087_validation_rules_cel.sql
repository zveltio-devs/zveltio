-- 087_validation_rules_cel.sql
--
-- Expression rules (`custom`, `nlp`) are now CEL, evaluated by @bufbuild/cel
-- (lib/validation-engine.ts). They were expr-eval-fork expressions. The two
-- languages share comparisons, arithmetic, `? :`, `in`, list literals and both
-- quote styles; the difference rule authors actually used is the logical
-- keywords: expr-eval spells them `and` / `or`, CEL `&&` / `||`. Both pairs have
-- the same precedence relative to each other and to comparisons.
--
-- Division is the one place a rewritten rule could change meaning instead of
-- failing: expr-eval divides as JavaScript does, while CEL binds an integer
-- field's value as `int`, where `7 / 2` is 3 and `%` is integer remainder. A rule
-- with `/` or `%` is therefore never rewritten; it stays expr-eval and is
-- refused, so someone re-reads it.
--
-- Rewritten only where that is certain:
--   - the keyword appears outside string literals, and no literal contains it
--     (`value == 'black and white'` keeps its literal);
--   - the expression has no `||`, which in expr-eval is string concatenation;
--   - the expression has no `/` or `%` (above), and no backslash: the literal
--     test below does not understand escapes, so `'it\'s or not'` would hide
--     a keyword inside a literal from it.
-- Anything else is left as written. The engine refuses an expression it cannot
-- parse as CEL — the write touching that field is refused and the log names the
-- rule and the CEL operators — so a rule this misses fails closed, never open.
-- `not` is left alone on purpose: `not value > 1` and `!value > 1` group
-- differently.
-- Re-runnable: a rewritten expression has no `and` / `or` left to match.

UPDATE zv_validation_rules
   SET rule_config = jsonb_set(
         rule_config,
         '{expression}',
         to_jsonb(regexp_replace(
           regexp_replace(rule_config->>'expression', '\mand\M', '&&', 'g'),
           '\mor\M', '||', 'g')))
 WHERE rule_type IN ('custom', 'nlp')
   AND rule_config->>'expression' !~ '\|\||[/%\\]'
   AND regexp_replace(rule_config->>'expression', '''[^'']*''|"[^"]*"', '', 'g') ~ '\m(and|or)\M'
   AND NOT EXISTS (
         SELECT 1
           FROM regexp_matches(rule_config->>'expression', '''[^'']*''|"[^"]*"', 'g') AS lit(m)
          WHERE lit.m[1] ~ '\m(and|or)\M');

-- DOWN
-- The engine before this migration runs expr-eval, which has no `&&` / `||`
-- operators (its `||` concatenates). Spell them back as `and` / `or`, under the
-- same guards. A rule that uses CEL-only syntax (`size()`, macros, `!`) stays
-- as written and is refused by that engine, as any unparseable rule is.
UPDATE zv_validation_rules
   SET rule_config = jsonb_set(
         rule_config,
         '{expression}',
         to_jsonb(replace(replace(rule_config->>'expression', '&&', ' and '), '||', ' or ')))
 WHERE rule_type IN ('custom', 'nlp')
   AND rule_config->>'expression' !~ '\\'
   AND regexp_replace(rule_config->>'expression', '''[^'']*''|"[^"]*"', '', 'g') ~ '&&|\|\|'
   AND NOT EXISTS (
         SELECT 1
           FROM regexp_matches(rule_config->>'expression', '''[^'']*''|"[^"]*"', 'g') AS lit(m)
          WHERE lit.m[1] ~ '&&|\|\|');
