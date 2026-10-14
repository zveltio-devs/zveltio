-- 077_revision_masking.sql
--
-- A revision does not give back a column a rule hides (L37).
--
-- `zv_revisions` keeps a copy of the whole row in `data` and `delta`, a column
-- `zvd_column_permissions` hides from the actor included — and the revision is
-- the engine's own read, so it must (a revert would wipe the value otherwise).
-- 075 masks the live row; `zveltio_rls` still read the copies straight off
-- `zv_revisions`. The same pattern 074 closed for password hashes.
--
-- `zveltio_mask_revisions()` builds `zvv__revisions` (two underscores: no
-- collection is named `_revisions`, and no extension prefix `zv_<ext>_` reaches
-- it), and takes SELECT on `data` and `delta` from every role but the owner
-- (`zveltio_seal_columns`, 073 — a role granted the table later mirrors
-- `zveltio_rls`). The view serves both without the keys a rule hides from
-- `zveltio.user_role` (or `*`) in the row's collection, and without
-- `search_vector`/`search_text`, which carry every text field and are served to
-- no one. It stands down where 075's views do: no actor, `columns_all`,
-- `engine_read`, the collection in `system_collections`. A copy stored as a
-- jsonb string of an object (the double-encoded form 009 repaired, which the
-- readers still accept) is unwrapped to be masked; any other non-object reads as
-- NULL — it cannot be masked, so it is not served.
--
-- Definer only where the owner is bound by the tenant policy, invoker (and the
-- columns left granted) where it is not, as 075 decides it: a SUPERUSER or
-- BYPASSRLS owner would read every tenant through a definer view. The rules are
-- one uncorrelated subquery, evaluated once per statement, not once per row.
--
-- Idempotent and re-run at every boot (`reconcileSealedColumns`), so the
-- definer/invoker answer follows the owner's attributes, as 075's views do.

CREATE OR REPLACE FUNCTION zveltio_mask_revisions()
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  rel regclass := to_regclass('public.zv_revisions');
  definer boolean;
  items text[] := '{}';
  body text;
  tag text;
  changed boolean := false;
  a record;
  g record;
BEGIN
  IF rel IS NULL OR to_regclass('public.zvd_column_permissions') IS NULL THEN
    RETURN false;
  END IF;
  SELECT c.relrowsecurity AND c.relforcerowsecurity AND c.relowner = r.oid
           AND NOT (r.rolsuper OR r.rolbypassrls)
    INTO definer
    FROM pg_class c, pg_roles r
   WHERE c.oid = rel AND r.rolname = current_user;
  definer := coalesce(definer, false);

  FOR a IN
    SELECT attname::text AS name FROM pg_attribute
     WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped ORDER BY attnum
  LOOP
    IF a.name IN ('data', 'delta') THEN
      items := items || format(
        'CASE WHEN coalesce(current_setting(''zveltio.actor'', true), '''') <> ''on'''
        ' OR coalesce(current_setting(''zveltio.columns_all'', true), '''') = ''on'''
        ' OR coalesce(current_setting(''zveltio.engine_read'', true), '''') = ''on'''
        ' OR strpos(coalesce(current_setting(''zveltio.system_collections'', true), ''''), '',*,'') > 0'
        ' OR strpos(coalesce(current_setting(''zveltio.system_collections'', true), ''''), '','' || t.collection || '','') > 0'
        ' THEN t.%1$I'
        ' WHEN jsonb_typeof(t.%1$I) = ''object'' THEN t.%1$I %2$s'
        ' WHEN jsonb_typeof(t.%1$I) = ''string'' AND left(t.%1$I #>> ''{}'', 1) = ''{'''
        ' THEN (t.%1$I #>> ''{}'')::jsonb %2$s'
        ' END AS %1$I',
        a.name,
        '- ''{search_vector,search_text}''::text[]'
        ' - ARRAY(SELECT jsonb_array_elements_text(h.hidden -> t.collection))');
    ELSE
      items := items || format('t.%I', a.name);
    END IF;
  END LOOP;

  body := format(
    'SELECT %s FROM public.zv_revisions t, (SELECT coalesce(jsonb_object_agg(m.collection_name, m.cols), ''{}'') AS hidden'
    ' FROM (SELECT p.collection_name, jsonb_agg(p.column_name) AS cols FROM public.zvd_column_permissions p'
    ' WHERE NOT p.can_read AND p.role IN (coalesce(current_setting(''zveltio.user_role'', true), ''''), ''*'')'
    ' GROUP BY p.collection_name) m) h',
    array_to_string(items, ', '));
  tag := 'zveltio:' || md5(concat_ws('|', definer, body));

  IF obj_description(to_regclass('public.zvv__revisions'), 'pg_class') IS DISTINCT FROM tag THEN
    -- Replicas booting together: one rebuilds, the next finds it done.
    PERFORM pg_advisory_xact_lock(hashtext('zveltio_mask_revisions'));
    IF obj_description(to_regclass('public.zvv__revisions'), 'pg_class') IS DISTINCT FROM tag THEN
      DROP VIEW IF EXISTS public.zvv__revisions;
      EXECUTE format('CREATE VIEW public.zvv__revisions%s AS %s',
                     CASE WHEN definer THEN '' ELSE ' WITH (security_invoker = true)' END, body);
      EXECUTE format('COMMENT ON VIEW public.zvv__revisions IS %L', tag);
      -- Default privileges (001) would give the narrow roles DML on it.
      FOR g IN
        SELECT DISTINCT x.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
         WHERE c.oid = 'public.zvv__revisions'::regclass AND x.grantee <> c.relowner
      LOOP
        EXECUTE format('REVOKE ALL ON public.zvv__revisions FROM %s',
          CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
      END LOOP;
      IF to_regrole('zveltio_rls') IS NOT NULL THEN
        GRANT SELECT ON public.zvv__revisions TO zveltio_rls;
      END IF;
      changed := true;
    END IF;
  END IF;

  RETURN zveltio_seal_columns(rel, CASE WHEN definer THEN '{data,delta}'::text[] ELSE '{}' END)
         OR changed;
END
$fn$;

REVOKE ALL ON FUNCTION zveltio_mask_revisions() FROM PUBLIC;

SELECT zveltio_mask_revisions();

-- DOWN

-- The engine below 077 reads `zv_revisions` itself: its grantees get the whole
-- table back before the view goes.
SELECT zveltio_seal_columns('public.zv_revisions'::regclass, '{}');
DROP VIEW IF EXISTS public.zvv__revisions;
DROP FUNCTION IF EXISTS zveltio_mask_revisions();
