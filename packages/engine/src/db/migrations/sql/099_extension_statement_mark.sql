-- 099_extension_statement_mark.sql
--
-- An extension's statement is told from the engine's by the role it runs as
-- (058): `zveltio_ext*` and the worker roles. Where the engine could not set
-- `zveltio_ext` up (a hand-made engine role without CREATEROLE, the bootstrap
-- script not run), an inline extension's `ctx.db` keeps the role it has —
-- `zveltio_rls` in a tenant transaction — and with no actor (a job, a per-tenant
-- schedule, a listener) the function read it as the engine's own work: every
-- collection of the tenant, read and written, row rules standing down. With its
-- role the same statement gets nothing.
--
-- There the engine marks the statement instead: `zveltio.ext_statement` is `on`
-- for exactly that statement, set and restored by the engine around it
-- (ext-db-role.ts), never by the extension — `set_config` is one of the functions
-- `ctx.db` refuses, the same guarantee that keeps it from `RESET ROLE`. A marked
-- statement is judged as an extension's: the actor's grants, asSystem's
-- collections, nothing else.
--
-- Body otherwise 058's; search_path pinned as 069 pins it (CREATE OR REPLACE
-- replaces the SET clause too).

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
