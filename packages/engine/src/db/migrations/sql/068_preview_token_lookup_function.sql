-- 068_preview_token_lookup_function.sql
--
-- A preview token is a credential, and the role that reads it no longer can.
--
-- `zv_schema_branches.preview_token` was readable by `zveltio_rls` — the role
-- every tenant transaction runs as — because the lookup in
-- middleware/preview-env.ts ran as that role. So any SQL that runs as it (an
-- insight query, an RPC function) could list every live token. Measured before
-- this migration, inside a tenant transaction:
--
--     SET LOCAL ROLE zveltio_rls;
--     SELECT preview_token FROM zv_schema_branches;   → every token
--
-- 1. The lookup becomes a SECURITY DEFINER function: token in, the branch's id
--    and schema out, only for a token that is enabled and not expired. An
--    expired token is cleared on the way, as the middleware did.
-- 2. `zveltio_rls` keeps SELECT on every other column (the branch routes read
--    them as that role) and loses it on `preview_token`. A column grant does
--    nothing beside a table-wide one, so the table grant goes and the columns
--    are granted one by one. Writing the column (enable, rotate, disable) needs
--    no SELECT on it and is untouched.
--
-- The boot re-grants every table in `public` to `zveltio_rls`, so
-- `ensureRlsEnforcementRole` (lib/tenancy/tenant-manager.ts) takes the column
-- back on every start as well; this file is what holds when that step cannot run.
--
-- Re-runnable.

CREATE OR REPLACE FUNCTION zveltio_preview_branch(p_token text)
  RETURNS TABLE (id uuid, preview_schema text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  UPDATE public.zv_schema_branches b
     SET preview_enabled = false, preview_token = NULL
   WHERE b.preview_token = p_token AND b.preview_expires_at <= now();
  RETURN QUERY
    SELECT b.id, b.preview_schema FROM public.zv_schema_branches b
     WHERE b.preview_token = p_token AND b.preview_enabled
       AND (b.preview_expires_at IS NULL OR b.preview_expires_at > now());
END
$$;

REVOKE ALL ON FUNCTION zveltio_preview_branch(text) FROM PUBLIC;

DO $$
DECLARE cols text;
BEGIN
  GRANT EXECUTE ON FUNCTION zveltio_preview_branch(text) TO zveltio_rls;
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
    FROM pg_attribute
   WHERE attrelid = 'public.zv_schema_branches'::regclass
     AND attnum > 0 AND NOT attisdropped AND attname <> 'preview_token';
  REVOKE SELECT ON public.zv_schema_branches FROM zveltio_rls;
  EXECUTE format('GRANT SELECT (%s) ON public.zv_schema_branches TO zveltio_rls', cols);
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE '068: no zveltio_rls role, zveltio_preview_branch stays the owner''s';
END $$;

-- DOWN

DO $$
BEGIN
  -- The table-wide REVOKE takes the column grants with it.
  REVOKE SELECT ON public.zv_schema_branches FROM zveltio_rls;
  GRANT SELECT ON public.zv_schema_branches TO zveltio_rls;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;
DROP FUNCTION IF EXISTS zveltio_preview_branch(text);
