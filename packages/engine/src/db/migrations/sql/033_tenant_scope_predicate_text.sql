-- 033_tenant_scope_predicate_text.sql
--
-- A TEXT overload of the tenant visibility rule.
--
-- Migration 029 typed `zveltio_tenant_scope_ok` on uuid, which is what a
-- tenant_id ought to be and what 289 of the 292 declarations in the ecosystem
-- say. The other three do not: `billing` declares `tenant_id TEXT` on two
-- tables and UUID on a third, and the engine's own `zv_extension_registry`
-- uses TEXT. Nobody had noticed, because the predicate everyone used compared
-- `tenant_id::text` and accepted either. Typing 029 properly turned that
-- inconsistency into a migration failure — `function
-- zveltio_tenant_scope_ok(text) does not exist` — which is the right way for
-- it to surface and the wrong thing to leave as the extension author's
-- problem.
--
-- Extensions are installed from a registry onto engines their author never
-- sees, so the host absorbs this: the rule stays one rule, offered at two entry
-- points, and a third-party table works whichever type it happens to use.
--
-- A separate migration rather than an edit to 029 because 029 has shipped.
-- Migrations run once, by number, so appending to an applied file reaches only
-- installs that had not run it yet — the ones that had would be missing the
-- overload with nothing to tell them.

-- The same rule for a `tenant_id` that is TEXT rather than UUID.
--
-- Not hypothetical: `billing` declares `tenant_id TEXT` on two of its tables
-- and UUID on a third, and the engine's own `zv_extension_registry` uses TEXT.
-- Nobody noticed because the predicate everyone had been using compared
-- `tenant_id::text`, which accepts either. Typing this one properly surfaced
-- the inconsistency as a migration failure — the right outcome, and it must not
-- be the extension author's problem to fix.
--
-- Extensions come from a registry and run on engines their author never sees,
-- so an overload is the honest answer: the rule stays one rule, expressed at
-- both entry points, and a third-party table works whichever type it chose.
CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT row_tenant = COALESCE(
    NULLIF(current_setting('zveltio.current_tenant', true), ''),
    '00000000-0000-0000-0000-000000000001'
  )
$$;

COMMENT ON FUNCTION zveltio_tenant_scope_ok(text) IS
  'TEXT overload of the tenant visibility rule, for tables whose tenant_id is '
  'text rather than uuid. Same semantics as the uuid form. See migration 029.';
