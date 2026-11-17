-- 125_no_collection_rls_exemption.sql
--
-- ADR 0058 decision 4 removes ZVELTIO_COLLECTION_RLS_EXEMPT. The variable made
-- the engine GRANT `zveltio_coll_exempt` to an extension's roles, and this
-- function admitted any member. A GRANT outlives the variable: a database
-- exempted before the upgrade would keep the exemption with nothing left to
-- name it or take it back. So the function stops asking: an extension's
-- statement gets the actor's grants and asSystem's collections, nothing else.
--
-- The role itself stays, inert: it is a cluster object that backup/restore
-- lists by name (lib/backup/dump.ts); retiring it is its own change.
--
-- Body otherwise 099's.

CREATE OR REPLACE FUNCTION zveltio_collection_allows(coll text, act text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  actor boolean := coalesce(current_setting('zveltio.actor', true), '') = 'on';
  sys text := coalesce(current_setting('zveltio.system_collections', true), '');
  g text;
BEGIN
  IF act = 'read'
     AND lower(coalesce(nullif(current_setting('zveltio.rls_bypass', true), ''), 'off')) IN ('on', 'true', '1') THEN
    RETURN true;
  END IF;
  IF sys <> '' AND (strpos(sys, ',' || coll || ',') > 0 OR strpos(sys, ',*,') > 0) THEN
    RETURN true;
  END IF;
  IF actor THEN
    IF coalesce(current_setting('zveltio.collection_all', true), '') = 'on' THEN
      RETURN true;
    END IF;
    g := coalesce(current_setting('zveltio.collection_grants', true), '');
    IF strpos(g, ',' || coll || ':' || act || ',') > 0
       OR strpos(g, ',' || coll || ':*,') > 0
       OR strpos(g, ',*:' || act || ',') > 0 THEN
      RETURN true;
    END IF;
  END IF;
  IF coalesce(current_setting('zveltio.ext_statement', true), '') = 'on' THEN
    RETURN false;
  END IF;
  -- An extension's role with no actor grant gets nothing; no role is exempt.
  IF current_user::text ~ '^zveltio_(ext|extb|wrk)(_|$)' OR current_user::text = 'zveltio_worker' THEN
    RETURN false;
  END IF;
  RETURN NOT actor;
END
$fn$;

-- DOWN

CREATE OR REPLACE FUNCTION zveltio_collection_allows(coll text, act text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  actor boolean := coalesce(current_setting('zveltio.actor', true), '') = 'on';
  sys text := coalesce(current_setting('zveltio.system_collections', true), '');
  g text;
BEGIN
  IF act = 'read'
     AND lower(coalesce(nullif(current_setting('zveltio.rls_bypass', true), ''), 'off')) IN ('on', 'true', '1') THEN
    RETURN true;
  END IF;
  IF sys <> '' AND (strpos(sys, ',' || coll || ',') > 0 OR strpos(sys, ',*,') > 0) THEN
    RETURN true;
  END IF;
  IF actor THEN
    IF coalesce(current_setting('zveltio.collection_all', true), '') = 'on' THEN
      RETURN true;
    END IF;
    g := coalesce(current_setting('zveltio.collection_grants', true), '');
    IF strpos(g, ',' || coll || ':' || act || ',') > 0
       OR strpos(g, ',' || coll || ':*,') > 0
       OR strpos(g, ',*:' || act || ',') > 0 THEN
      RETURN true;
    END IF;
  END IF;
  IF coalesce(current_setting('zveltio.ext_statement', true), '') = 'on' THEN
    RETURN false;
  END IF;
  -- Below: the two that look at the ROLE, asked last because they cost most.
  IF current_user::text ~ '^zveltio_(ext|extb|wrk)(_|$)' OR current_user::text = 'zveltio_worker' THEN
    RETURN EXISTS (
      SELECT 1 FROM pg_roles r
       WHERE r.rolname = 'zveltio_coll_exempt'
         AND pg_has_role(current_user, r.oid, 'USAGE')
    );
  END IF;
  RETURN NOT actor;
END
$fn$;
