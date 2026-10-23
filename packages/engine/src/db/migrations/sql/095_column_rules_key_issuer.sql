-- 095_column_rules_key_issuer.sql
--
-- A key's column rules in the database are its own AND its issuer's (L37).
--
-- The engine bounds an API key's columns by its issuer's rules as the issuer is
-- now (`keyColumnAccess`): a rule hiding a column from `member` hides it from a
-- member's key. The database layers read one role, `zveltio.user_role`, which
-- for a key is `api_key` — so the write guard (072), the masking views (075) and
-- the revision view (077) applied the key's own rules only. A statement that
-- reached the database under the key's identity (an extension's `ctx.db`, a
-- worker, any path that skips the engine's filter) read the column through
-- `zvv_<collection>` and its history, and wrote it on the table.
--
-- The engine now publishes the issuer's role as `zveltio.issuer_role`
-- (`publishApiKeyActor`); it is `''` for a session, a job key, and an issuer
-- holding `data:view_all_columns`, whose half of the rules the engine waives
-- too. All three functions apply the rules of `user_role`, `issuer_role` and
-- `*`. Nothing else changes: the trigger argument is the same, so the existing
-- triggers take the new function as they are; each view's definition changes,
-- so its hash does, and the boot reconcile (`reconcileSealedColumns`) rebuilds
-- every collection view; the revision view is rebuilt here, as 077 built it.
-- The settings are transaction-local, so a replica that does not publish
-- `issuer_role` yet reads `''` and keeps the old behaviour.
--
-- Replaced in place, so owner, grants and search_path are unchanged.

CREATE OR REPLACE FUNCTION zveltio_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  spec jsonb;
  sys text;
  cols text[];
  skip text[];
  n jsonb;
  o jsonb;
  q text;
  d1 jsonb;
  d2 jsonb;
  bad text[];
BEGIN
  IF coalesce(current_setting('zveltio.actor', true), '') <> 'on' OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('zveltio.columns_all', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  sys := coalesce(current_setting('zveltio.system_collections', true), '');
  IF sys <> '' AND (strpos(sys, ',' || substr(TG_TABLE_NAME, 5) || ',') > 0 OR strpos(sys, ',*,') > 0) THEN
    RETURN NEW;
  END IF;

  spec := TG_ARGV[0]::jsonb;
  SELECT array_agg(DISTINCT c) INTO cols
    FROM jsonb_array_elements_text(
           coalesce(spec->'roles'->coalesce(current_setting('zveltio.user_role', true), ''), '[]'::jsonb)
           || coalesce(spec->'roles'->coalesce(current_setting('zveltio.issuer_role', true), ''), '[]'::jsonb)
           || coalesce(spec->'roles'->'*', '[]'::jsonb)) c;
  IF cols IS NULL THEN
    RETURN NEW;
  END IF;

  skip := ARRAY(SELECT jsonb_array_elements_text(spec->'system'));
  n := to_jsonb(NEW) - skip;
  IF '*' = ANY (cols) THEN
    cols := ARRAY(SELECT jsonb_object_keys(n));
  END IF;

  IF TG_OP = 'UPDATE' THEN
    o := to_jsonb(OLD) - skip;
    bad := ARRAY(SELECT c FROM unnest(cols) c
                  WHERE n->c IS NOT NULL AND n->c IS DISTINCT FROM o->c ORDER BY c);
  ELSE
    SELECT string_agg(format('(%s)::%s AS %I', pg_get_expr(ad.adbin, ad.adrelid),
                             format_type(a.atttypid, a.atttypmod), a.attname), ', ')
      INTO q
      FROM pg_attribute a
      JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE a.attrelid = TG_RELID AND a.attname = ANY (cols)
       AND NOT a.attisdropped AND a.attgenerated = '';
    IF q IS NOT NULL THEN
      -- Twice, in one statement: a default that differs from itself is volatile.
      EXECUTE format('SELECT to_jsonb(x), to_jsonb(y) FROM (SELECT %s) x, (SELECT %s) y', q, q)
        INTO d1, d2;
    END IF;
    bad := ARRAY(SELECT c FROM unnest(cols) c
                  WHERE n->c IS NOT NULL
                    AND (d1->c IS NOT DISTINCT FROM d2->c)
                    AND n->c IS DISTINCT FROM coalesce(d1->c, 'null'::jsonb)
                  ORDER BY c);
  END IF;

  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'column-level permission denies writing % on %',
                    array_to_string(bad, ', '), TG_TABLE_NAME
      USING ERRCODE = '42501', CONSTRAINT = 'zv_column_guard',
            TABLE = TG_TABLE_NAME, COLUMN = bad[1];
  END IF;
  RETURN NEW;
END
$fn$;

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
               ELSE format(' OR (coalesce(current_setting(''zveltio.user_role'', true), '''') <> ALL (%1$L::text[])'
                           ' AND coalesce(current_setting(''zveltio.issuer_role'', true), '''') <> ALL (%1$L::text[]))',
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
    ' WHERE NOT p.can_read AND p.role IN (coalesce(current_setting(''zveltio.user_role'', true), ''''),'
    ' coalesce(current_setting(''zveltio.issuer_role'', true), ''''), ''*'')'
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

SELECT zveltio_mask_revisions();

-- DOWN

-- 072's, 075's and 077's definitions. The collection views go back at the next
-- boot reconcile, as they came forward.

CREATE OR REPLACE FUNCTION zveltio_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  spec jsonb;
  sys text;
  cols text[];
  skip text[];
  n jsonb;
  o jsonb;
  q text;
  d1 jsonb;
  d2 jsonb;
  bad text[];
BEGIN
  IF coalesce(current_setting('zveltio.actor', true), '') <> 'on' OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('zveltio.columns_all', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  sys := coalesce(current_setting('zveltio.system_collections', true), '');
  IF sys <> '' AND (strpos(sys, ',' || substr(TG_TABLE_NAME, 5) || ',') > 0 OR strpos(sys, ',*,') > 0) THEN
    RETURN NEW;
  END IF;

  spec := TG_ARGV[0]::jsonb;
  SELECT array_agg(DISTINCT c) INTO cols
    FROM jsonb_array_elements_text(
           coalesce(spec->'roles'->coalesce(current_setting('zveltio.user_role', true), ''), '[]'::jsonb)
           || coalesce(spec->'roles'->'*', '[]'::jsonb)) c;
  IF cols IS NULL THEN
    RETURN NEW;
  END IF;

  skip := ARRAY(SELECT jsonb_array_elements_text(spec->'system'));
  n := to_jsonb(NEW) - skip;
  IF '*' = ANY (cols) THEN
    cols := ARRAY(SELECT jsonb_object_keys(n));
  END IF;

  IF TG_OP = 'UPDATE' THEN
    o := to_jsonb(OLD) - skip;
    bad := ARRAY(SELECT c FROM unnest(cols) c
                  WHERE n->c IS NOT NULL AND n->c IS DISTINCT FROM o->c ORDER BY c);
  ELSE
    SELECT string_agg(format('(%s)::%s AS %I', pg_get_expr(ad.adbin, ad.adrelid),
                             format_type(a.atttypid, a.atttypmod), a.attname), ', ')
      INTO q
      FROM pg_attribute a
      JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE a.attrelid = TG_RELID AND a.attname = ANY (cols)
       AND NOT a.attisdropped AND a.attgenerated = '';
    IF q IS NOT NULL THEN
      -- Twice, in one statement: a default that differs from itself is volatile.
      EXECUTE format('SELECT to_jsonb(x), to_jsonb(y) FROM (SELECT %s) x, (SELECT %s) y', q, q)
        INTO d1, d2;
    END IF;
    bad := ARRAY(SELECT c FROM unnest(cols) c
                  WHERE n->c IS NOT NULL
                    AND (d1->c IS NOT DISTINCT FROM d2->c)
                    AND n->c IS DISTINCT FROM coalesce(d1->c, 'null'::jsonb)
                  ORDER BY c);
  END IF;

  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'column-level permission denies writing % on %',
                    array_to_string(bad, ', '), TG_TABLE_NAME
      USING ERRCODE = '42501', CONSTRAINT = 'zv_column_guard',
            TABLE = TG_TABLE_NAME, COLUMN = bad[1];
  END IF;
  RETURN NEW;
END
$fn$;

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

SELECT zveltio_mask_revisions();
