-- 061_edge_egress_column.sql
--
-- An edge function's egress is a column, not an env var (owner decision
-- 2026-10-10).
--
-- RFC step 10 (#1022) read the hosts a function may reach from its env var
-- `ZVELTIO_EGRESS`. An env var is a secret's place: nothing validated it at
-- save (a mistyped host failed every invocation instead), it could not be
-- queried without parsing JSON, and the permission it grants sat beside the
-- credentials it is meant to be separate from. Now `egress`:
--
--   NULL      the function declares nothing (stays the engine's child, as before)
--   '{}'      it declares no egress (runner by default; reaches nothing)
--   '{a,b}'   it reaches exactly those authorities
--
-- The CHECK holds every row to the form parseEgress (lib/edge-functions/egress.ts)
-- reads: a lower-case host name, an IPv6 literal in brackets, optionally
-- `:port`; no scheme, path, wildcard, empty or NULL entry. Whatever writes the
-- row — the extension's API, a seed, a hand-written UPDATE — cannot store a
-- host the engine would read as something else.
--
-- The env var's existing values move into the column, lower-cased and split as
-- parseEgress split them, and the key leaves `env_vars`: one source. An entry
-- that is not a host is dropped with a NOTICE — parseEgress refused the whole
-- list at invocation, so such a function failed every call; dropping the entry
-- can only narrow what it reaches. The table is under FORCE RLS, so a plain
-- owner role writes each row as its tenant (as 043 does). Re-runnable.

ALTER TABLE zv_edge_functions ADD COLUMN IF NOT EXISTS egress text[];

DO $$
DECLARE
  entry constant text :=
    '(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:[0-9]{1,5})?';
  r record;
BEGIN
  PERFORM set_config(
    'zveltio.visible_tenants',
    coalesce((SELECT string_agg(id::text, ',') FROM zv_tenants), ''),
    true);
  FOR r IN
    SELECT id, tenant_id, name, lower(env_vars->>'ZVELTIO_EGRESS') AS raw
      FROM zv_edge_functions
     WHERE env_vars ? 'ZVELTIO_EGRESS'
  LOOP
    PERFORM set_config('zveltio.current_tenant', r.tenant_id::text, true);
    UPDATE zv_edge_functions
       SET egress = ARRAY(
             SELECT e FROM regexp_split_to_table(coalesce(r.raw, ''), '[\s,]+') AS e
              WHERE e ~ ('^' || entry || '$')
           ),
           env_vars = env_vars - 'ZVELTIO_EGRESS'
     WHERE id = r.id;
    IF EXISTS (
      SELECT 1 FROM regexp_split_to_table(coalesce(r.raw, ''), '[\s,]+') AS e
       WHERE e <> '' AND e !~ ('^' || entry || '$')
    ) THEN
      RAISE NOTICE '061: edge function % — ZVELTIO_EGRESS entries that are not hosts were dropped', r.name;
    END IF;
  END LOOP;
  PERFORM set_config('zveltio.current_tenant', '', true);
  PERFORM set_config('zveltio.visible_tenants', '', true);

  ALTER TABLE zv_edge_functions DROP CONSTRAINT IF EXISTS zv_edge_functions_egress_check;
  EXECUTE format(
    'ALTER TABLE zv_edge_functions ADD CONSTRAINT zv_edge_functions_egress_check CHECK ('
    || 'egress IS NULL OR cardinality(egress) = 0 '
    || 'OR array_to_string(egress, '','', '''') ~ %L)',
    '^' || entry || '(,' || entry || ')*$'
  );
END $$;

-- DOWN
ALTER TABLE zv_edge_functions DROP CONSTRAINT IF EXISTS zv_edge_functions_egress_check;
DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config(
    'zveltio.visible_tenants',
    coalesce((SELECT string_agg(id::text, ',') FROM zv_tenants), ''),
    true);
  FOR t IN SELECT DISTINCT tenant_id FROM zv_edge_functions WHERE egress IS NOT NULL LOOP
    PERFORM set_config('zveltio.current_tenant', t::text, true);
    UPDATE zv_edge_functions
       SET env_vars = env_vars
                      || jsonb_build_object('ZVELTIO_EGRESS', array_to_string(egress, ', '))
     WHERE tenant_id = t AND egress IS NOT NULL;
  END LOOP;
  PERFORM set_config('zveltio.current_tenant', '', true);
  PERFORM set_config('zveltio.visible_tenants', '', true);
END $$;
ALTER TABLE zv_edge_functions DROP COLUMN IF EXISTS egress;
