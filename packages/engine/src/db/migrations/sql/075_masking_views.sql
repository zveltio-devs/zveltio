-- 075_masking_views.sql
--
-- A column hidden from a role is hidden by the database too (L37, layer 3).
--
-- `zvd_column_permissions` rows with `can_read = false` were applied only by the
-- engine (`applyColumnAccess`), so raw SQL on `zveltio_rls` — or on the narrower
-- roles extensions and flows run as — read the hidden value. Layer 1 (072) guards
-- the writes; this guards the reads.
--
-- Every collection table gets a view `zvv_<collection>`, rebuilt by
-- `zveltio_mask_columns()` whenever its columns or rules change. A column with a
-- read rule is projected as
--
--   CASE WHEN <the actor may read it> THEN t.col END AS col
--
-- and every other column passes through; an unserved column (`password`, 073)
-- is not in the view at all. `search_vector` and `search_text` are built from
-- every text field, so they are hidden wherever one of those is. The actor is
-- read from the settings layer 1 reads, and the view stands down where it does:
--
--   no actor                the engine's own work: boot, reconcilers, jobs;
--   zveltio.columns_all     the `data:view_all_columns` exemption (a god);
--   system_collections      an extension inside `asSystem`;
--   zveltio.engine_read     the engine reading a row for itself — a write's
--                           before-row and its RETURNING (`withEngineColumns`),
--                           which feed revisions, hooks and webhooks as before.
--
-- Otherwise a column is hidden when a rule names `zveltio.user_role` or `*`.
--
-- Definer, not invoker: the view reads the table as its owner, so the request
-- roles lose SELECT on the ruled columns of the table itself (`zveltio_seal_columns`,
-- 073) and the view is the only way to them. Tenant isolation still applies:
-- the table is FORCE RLS and its policies are on PUBLIC and read the settings,
-- not the role, so they bind the owner reading through the view exactly as they
-- bind `zveltio_rls` reading the table. That holds only where the owner IS bound
-- — a SUPERUSER or BYPASSRLS owner, or a table without FORCE, would let a definer
-- view read every tenant. There the view is `security_invoker` and the ruled
-- columns stay granted: the engine's own reads are still masked, raw SQL on the
-- table is not (the shape the engine already warns about at boot).
--
-- Not `security_barrier`: the view has no WHERE of its own (the rows are the
-- policies' job, on the table), and a barrier view is never flattened — measured
-- on Postgres 18, `ORDER BY created_at DESC LIMIT n`, what every list issues,
-- went from a backward index scan to a sequential scan and sort. The masking is
-- in the target list, so a predicate on the view sees the masked value either way.
--
-- Accepted limit, shared with layers 1 and 2: the settings are the request's
-- own, and raw SQL on the request role can set them. These layers stop the
-- engine and the narrow roles forgetting a rule, not a caller who forges an actor.
--
-- `zveltio_mask_columns(rel, unserved, system, search)`:
--
--   unserved  columns served to no one: left out of the view, sealed on the table;
--   system    columns the engine sets itself, never masked (`SYSTEM_COLUMNS`);
--   search    the text fields `search_vector` / `search_text` are built from.
--
-- Idempotent: the view carries a hash of its definition in its comment and is
-- rebuilt only when that changes. Locks the view before the table, the order a
-- reader takes them, so a rebuild racing a read waits instead of deadlocking.
-- Grants SELECT on the view to `zveltio_rls` alone: default privileges (001)
-- would give it DML on a view the owner creates, and the other narrow roles
-- reach collection data through their own allowlists, not through this view.
--
-- The views themselves are created by the engine's boot reconcile, as 072's
-- triggers and 073's grants are: which columns are unserved, and which are
-- system columns, is the field type registry's answer, not this file's.

CREATE OR REPLACE FUNCTION zveltio_mask_columns(
  rel regclass,
  unserved text[],
  system text[],
  search text[]
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  tbl text;
  coll text;
  vname text;
  definer boolean;
  masks jsonb;
  every text[];
  derived text[];
  roles text[];
  stand_down text;
  items text[];
  ruled text[];
  body text;
  tag text;
  locked boolean := false;
  changed boolean := false;
  a record;
  g record;
BEGIN
  IF rel IS NULL THEN
    RETURN false;
  END IF;
  LOOP
    SELECT c.relname,
           c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = r.oid
             AND NOT (r.rolsuper OR r.rolbypassrls)
      INTO tbl, definer
      FROM pg_class c, pg_roles r
     WHERE c.oid = rel AND c.relkind = 'r' AND r.rolname = current_user;
    IF tbl IS NULL OR NOT starts_with(tbl, 'zvd_') THEN
      RETURN false;
    END IF;
    coll := substr(tbl, 5);
    vname := 'zvv_' || coll;

    SELECT coalesce(jsonb_object_agg(column_name, rs), '{}') INTO masks
      FROM (SELECT column_name, jsonb_agg(DISTINCT role) AS rs
              FROM zvd_column_permissions
             WHERE collection_name = coll AND NOT can_read
             GROUP BY column_name) m;
    every := ARRAY(SELECT jsonb_array_elements_text(coalesce(masks->'*', '[]')));
    derived := ARRAY(SELECT jsonb_array_elements_text(masks->s) FROM unnest(search) s WHERE masks ? s);
    stand_down := format(
      'coalesce(current_setting(''zveltio.actor'', true), '''') <> ''on'''
      ' OR coalesce(current_setting(''zveltio.columns_all'', true), '''') = ''on'''
      ' OR coalesce(current_setting(''zveltio.engine_read'', true), '''') = ''on'''
      ' OR strpos(coalesce(current_setting(''zveltio.system_collections'', true), ''''), %L) > 0'
      ' OR strpos(coalesce(current_setting(''zveltio.system_collections'', true), ''''), '',*,'') > 0',
      ',' || coll || ',');

    items := '{}';
    ruled := '{}';
    FOR a IN
      SELECT attname::text AS name, format_type(atttypid, atttypmod) AS typ FROM pg_attribute
       WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped ORDER BY attnum
    LOOP
      CONTINUE WHEN a.name = ANY (unserved);
      IF a.name IN ('search_vector', 'search_text') THEN
        roles := every || derived;
      ELSIF a.name = ANY (system) THEN
        roles := '{}';
      ELSE
        roles := every || ARRAY(SELECT jsonb_array_elements_text(coalesce(masks->a.name, '[]')));
      END IF;
      IF cardinality(roles) = 0 THEN
        items := items || format('t.%I', a.name);
      ELSE
        ruled := ruled || a.name;
        -- Cast back to the column's own type: CASE drops a typmod, and a result
        -- type that changes with a rule makes every prepared `SELECT *` on the
        -- view fail once per connection (0A000).
        items := items || format('(CASE WHEN %s%s THEN t.%I END)::%s AS %I', stand_down,
          CASE WHEN '*' = ANY (roles) THEN ''
               ELSE format(' OR coalesce(current_setting(''zveltio.user_role'', true), '''') <> ALL (%L::text[])',
                           roles) END,
          a.name, a.typ, a.name);
      END IF;
    END LOOP;

    body := format('SELECT %s FROM public.%I t', array_to_string(items, ', '), tbl);
    -- The table's oid too: a Ghost DDL swap leaves the same text over another table.
    tag := 'zveltio:' || md5(concat_ws('|', rel::oid, definer, body));
    EXIT WHEN locked
           OR obj_description(to_regclass(format('public.%I', vname)), 'pg_class')
                IS NOT DISTINCT FROM tag;
    -- Locked, then everything read again: the one that read the older rules
    -- must not write last.
    IF to_regclass(format('public.%I', vname)) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', vname);
    END IF;
    EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', rel);
    locked := true;
  END LOOP;

  IF obj_description(to_regclass(format('public.%I', vname)), 'pg_class') IS DISTINCT FROM tag THEN
    EXECUTE format('DROP VIEW IF EXISTS public.%I', vname);
    EXECUTE format('CREATE VIEW public.%I%s AS %s', vname,
                   CASE WHEN definer THEN '' ELSE ' WITH (security_invoker = true)' END, body);
    EXECUTE format('COMMENT ON VIEW public.%I IS %L', vname, tag);
    FOR g IN
      SELECT DISTINCT x.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
       WHERE c.oid = to_regclass(format('public.%I', vname)) AND x.grantee <> c.relowner
    LOOP
      EXECUTE format('REVOKE ALL ON public.%I FROM %s', vname,
        CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
    END LOOP;
    IF to_regrole('zveltio_rls') IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO zveltio_rls', vname);
    END IF;
    changed := true;
  END IF;

  -- A definer view is the only way to a ruled column; an invoker view reads the
  -- table as the caller, who must keep it.
  RETURN zveltio_seal_columns(rel, unserved || CASE WHEN definer THEN ruled ELSE '{}' END)
         OR changed;
END
$fn$;

REVOKE ALL ON FUNCTION zveltio_mask_columns(regclass, text[], text[], text[]) FROM PUBLIC;

-- DOWN

-- The engine below 075 reads the tables, not the views: the views go, and every
-- collection table goes back to 073's shape — only its password columns sealed.
DO $down$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel, z.name,
           ARRAY(SELECT f->>'name' FROM jsonb_array_elements(
                   CASE jsonb_typeof(z.fields) WHEN 'array' THEN z.fields ELSE '[]' END) f
                  WHERE f->>'type' = 'password') AS pw
      FROM zvd_collections z
      JOIN pg_class c ON c.oid = to_regclass(format('public.%I', 'zvd_' || z.name))
  LOOP
    EXECUTE format('DROP VIEW IF EXISTS public.%I', 'zvv_' || r.name);
    PERFORM zveltio_seal_columns(r.rel, r.pw);
  END LOOP;
END
$down$;
DROP FUNCTION IF EXISTS zveltio_mask_columns(regclass, text[], text[], text[]);
