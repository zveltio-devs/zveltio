-- 057_tenant_reach_function.sql
--
-- The read reach of one assignment, resolved in ONE call.
--
-- `withTenantIsolation` used to resolve it from TypeScript: a membership query,
-- an ancestor walk, a count when nothing was in force, an org/subtree follow-up,
-- and only then the `set_config` that publishes it — up to five round trips on
-- every authenticated request, single-tenant installs included. Folding them
-- into one plain SQL statement worked but was planned on every request (0.7 ms
-- warm, for branches most callers never take). A function plans its statements
-- once per backend session and runs only the branch taken, so the request pays
-- one round trip and almost no planning.
--
-- The branches are the ones `resolveTenantScope` took, in the same order
-- (docs/platform/multi-tenancy.md §5):
--
--   - no row at all → NULL: a god user, an API key, or nobody enrolled. Publish
--     no set and let the equality predicate answer.
--   - rows, none in force → the impossible unit: an expired assignment sees
--     nothing. An empty set cannot say that; `NULLIF(guc, '')` reads it as
--     "no set published".
--   - otherwise the WIDEST reach in force. Assignments are grants, not filters;
--     two `list` reaches are a union. The own unit leads every set and appears
--     once, compared as the caller spelled it.
--
-- "In force" is `activeMembership()` in lib/tenancy/tenant-scope.ts: valid_from
-- inclusive, valid_to exclusive, NULL valid_to open-ended.
--
-- SECURITY INVOKER, deliberately: it is called before the transaction drops to
-- `zveltio_rls`, as the engine's own role, exactly as the queries it replaces.
-- Re-runnable: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION zveltio_tenant_reach(
  p_user text,
  p_tenant text,
  OUT visible_csv text,
  OUT ancestors_csv text
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
DECLARE
  v_tenant uuid := p_tenant::uuid;
  v_total int;
  v_live int;
  v_widest int;
  v_set text[];
BEGIN
  SELECT coalesce(string_agg(a::text, ','), '')
    INTO ancestors_csv
    FROM zveltio_tenant_ancestors(v_tenant) AS a
   WHERE a IS NOT NULL;

  SELECT count(*),
         count(*) FILTER (WHERE u.valid_from <= now() AND (u.valid_to IS NULL OR u.valid_to > now())),
         coalesce(max(CASE u.read_scope WHEN 'org' THEN 3 WHEN 'subtree' THEN 2
                                        WHEN 'list' THEN 1 ELSE 0 END)
                  FILTER (WHERE u.valid_from <= now() AND (u.valid_to IS NULL OR u.valid_to > now())), 0)
    INTO v_total, v_live, v_widest
    FROM zv_tenant_users u
   WHERE u.user_id = p_user AND u.tenant_id = v_tenant;

  IF v_total = 0 THEN
    visible_csv := NULL;
    RETURN;
  END IF;
  IF v_live = 0 THEN
    visible_csv := '00000000-0000-0000-0000-000000000000';
    RETURN;
  END IF;

  IF v_widest = 3 THEN
    SELECT coalesce(string_agg(t.id::text, ','), '') INTO visible_csv FROM zv_tenants t;
    RETURN;
  ELSIF v_widest = 2 THEN
    v_set := ARRAY(SELECT s::text FROM zveltio_tenant_subtree(v_tenant) AS s);
  ELSIF v_widest = 1 THEN
    v_set := ARRAY(
      SELECT e::text
        FROM zv_tenant_users l, unnest(l.scope_list) AS e
       WHERE l.user_id = p_user AND l.tenant_id = v_tenant AND l.read_scope = 'list'
         AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
    );
  ELSE
    visible_csv := p_tenant;
    RETURN;
  END IF;

  -- First occurrence wins, so the own unit stays first.
  SELECT string_agg(z.id, ',' ORDER BY z.o)
    INTO visible_csv
    FROM (
      SELECT x.id, min(x.o) AS o
        FROM unnest(ARRAY[p_tenant] || v_set) WITH ORDINALITY AS x(id, o)
       WHERE x.id IS NOT NULL AND x.id <> ''
       GROUP BY x.id
    ) z;
END;
$$;

COMMENT ON FUNCTION zveltio_tenant_reach(text, text) IS
  'The read reach of a user in a unit, as the GUC spelling: visible_csv (NULL = publish no set) and ancestors_csv. Called by withTenantIsolation before it drops to zveltio_rls.';

-- DOWN

DROP FUNCTION IF EXISTS zveltio_tenant_reach(text, text);
