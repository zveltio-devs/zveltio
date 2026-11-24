-- 136_retire_worker_and_flow_reader_roles.sql
--
-- RFC extension-model-v3 phase D slice 4, step 3: `zveltio_worker` (the worker
-- SQL bridge, deleted with every worker's `db:query` in #1911) and
-- `zveltio_flow_reader` (flow `query_db`, removed by ADR 0058) have no user.
-- Each still held DML or SELECT on every collection, and the engine created,
-- granted and switched into them at boot. A role nothing uses is a role an
-- analyzer miss or a forged GUC can still reach.
--
-- In this database: every privilege the two roles hold, and every privilege of
-- this database's per-extension worker roles (`zveltio_wrk_*`, named after this
-- database and an extension the registry knows, or holding a grant here), is
-- revoked, and the grants marker (121) stops naming them.
--
-- Roles belong to the cluster. Each is dropped only when nothing in ANY
-- database still depends on it: DROP ROLE refuses while another database holds
-- a grant to it (an older engine's database on the same cluster keeps it), and
-- that refusal is caught here, so the last database to retire a role drops it.
-- A role the engine may not drop (no CREATEROLE or ADMIN) stays, holding
-- nothing here. Re-runnable.
--
-- DOWN recreates the two shared roles (NOLOGIN, as 001 made them) and gives
-- them USAGE on the schema; the previous engine's boot grants them the
-- collections again (applyTenantRLS) and records them on the marker. The
-- per-extension worker roles come back when a worker extension loads.

DO $retire$
DECLARE
  me oid := (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database());
  r text;
  note text;
BEGIN
  FOR r IN
    SELECT ro.rolname
      FROM pg_catalog.pg_roles ro
     WHERE NOT ro.rolcanlogin
       AND (ro.rolname IN ('zveltio_worker', 'zveltio_flow_reader')
            OR (ro.rolname ~ '^zveltio_wrk_[a-z0-9_]+$'
                AND (EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d
                              WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass
                                AND d.refobjid = ro.oid AND d.dbid = me)
                     OR ro.rolname IN (
                       -- extensionDbRoleNames(): stem + sha256(db \0 name), 10 hex.
                       SELECT 'zveltio_wrk_'
                              || left(regexp_replace(lower(e.name), '[^a-z0-9]+', '_', 'g'), 38)
                              || '_'
                              || left(encode(sha256(convert_to(current_database(), 'UTF8') || '\x00'::bytea
                                                 || convert_to(e.name, 'UTF8')), 'hex'), 10)
                         FROM zv_extension_registry e))))
     -- The per-extension roles first: each is a member of zveltio_worker.
     ORDER BY ro.rolname IN ('zveltio_worker', 'zveltio_flow_reader'), ro.rolname
  LOOP
    BEGIN
      EXECUTE pg_catalog.format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE pg_catalog.format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE pg_catalog.format('REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM %I', r);
      EXECUTE pg_catalog.format('REVOKE ALL ON SCHEMA public FROM %I', r);
      EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), r);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'zveltio: privileges of % not revoked here (%)', r, SQLERRM;
    END;
    BEGIN
      EXECUTE pg_catalog.format('DROP ROLE %I', r);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'zveltio: role % kept (%)', r, SQLERRM;
    END;
  END LOOP;

  IF to_regprocedure('public.zveltio_role_grants_marker()') IS NOT NULL THEN
    SELECT string_agg(x, ',' ORDER BY x) INTO note
      FROM unnest(string_to_array(coalesce(
             obj_description(to_regprocedure('public.zveltio_role_grants_marker()'), 'pg_proc'),
             ''), ',')) AS x
     WHERE x <> '' AND x NOT IN ('zveltio_worker', 'zveltio_flow_reader');
    BEGIN
      EXECUTE pg_catalog.format('COMMENT ON FUNCTION public.zveltio_role_grants_marker() IS %L', note);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'zveltio: grants marker not rewritten (%)', SQLERRM;
    END;
  END IF;
END
$retire$;

-- DOWN

DO $restore$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['zveltio_worker', 'zveltio_flow_reader'] LOOP
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
        EXECUTE pg_catalog.format(
          'CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', r);
      END IF;
      EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA public TO %I', r);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'zveltio: role % not restored (%)', r, SQLERRM;
    END;
  END LOOP;
END
$restore$;
