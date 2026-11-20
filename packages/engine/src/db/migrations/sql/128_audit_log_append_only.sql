-- 128_audit_log_append_only.sql
--
-- ADR 0060 decisions 1 and 2: the audit trail is append-only for the engine's
-- request role, and a user's deletion no longer rewrites it.
--
-- `zveltio_rls` held SELECT, INSERT, UPDATE, DELETE on `zv_audit_log`
-- (baseline 062), so any path that reached the request role could rewrite or
-- remove an entry. It keeps SELECT and INSERT. The boot reconciler re-grants DML
-- on every table at each start (`ensureRlsEnforcementRole`); it takes these two
-- back the same way.
--
-- The retention purge is the one path that deletes, as `zveltio_audit_purge`:
-- SELECT and DELETE, nothing else, and only rows older than the window it
-- publishes in `zveltio.audit_retention_days` (at least one day; unset, empty or
-- zero deletes nothing). Its reach is every row so old, a purged tenant's too:
-- a tenant purge leaves the trail to retention (lib/tenancy/tenant-purge.ts).
-- The policies name the role through `current_user`, not `TO`: a login role
-- that inherits it must not inherit the restriction on its own deletes.
--
-- `user_id` loses its foreign key: ON DELETE SET NULL rewrote every row of an
-- erased user. The id stays and stops naming anyone once the profile is gone.
--
-- The table owner keeps every privilege; it is the migration and DDL identity.
-- What holds against it is the hash chain (ADR 0060 decision 3).
--
-- Re-runnable.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zveltio_audit_purge') THEN
    CREATE ROLE zveltio_audit_purge NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'zveltio: role zveltio_audit_purge not created (%)', SQLERRM;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zveltio_rls') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON zv_audit_log FROM zveltio_rls;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zveltio_audit_purge') THEN
    GRANT USAGE ON SCHEMA public TO zveltio_audit_purge;
    GRANT SELECT, DELETE ON zv_audit_log TO zveltio_audit_purge;
  END IF;
END
$$;

DROP POLICY IF EXISTS audit_log_purge_read ON zv_audit_log;
CREATE POLICY audit_log_purge_read ON zv_audit_log FOR SELECT
  USING (current_user = 'zveltio_audit_purge'
         AND created_at < now() - make_interval(
               days => NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int)
         AND NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int >= 1);

DROP POLICY IF EXISTS audit_log_purge ON zv_audit_log;
CREATE POLICY audit_log_purge ON zv_audit_log FOR DELETE
  USING (current_user = 'zveltio_audit_purge'
         AND created_at < now() - make_interval(
               days => NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int)
         AND NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int >= 1);

-- RESTRICTIVE: the instance-row policy (040) is permissive FOR ALL and would
-- otherwise hand the purge role every instance row, expired or not.
DROP POLICY IF EXISTS audit_log_purge_expired_only ON zv_audit_log;
CREATE POLICY audit_log_purge_expired_only ON zv_audit_log AS RESTRICTIVE FOR DELETE
  USING (current_user <> 'zveltio_audit_purge'
         OR (created_at < now() - make_interval(
               days => NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int)
             AND NULLIF(current_setting('zveltio.audit_retention_days', true), '')::int >= 1));

ALTER TABLE zv_audit_log DROP CONSTRAINT IF EXISTS zv_audit_log_user_id_fkey;

-- DOWN

DROP POLICY IF EXISTS audit_log_purge_expired_only ON zv_audit_log;
DROP POLICY IF EXISTS audit_log_purge ON zv_audit_log;
DROP POLICY IF EXISTS audit_log_purge_read ON zv_audit_log;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zveltio_audit_purge') THEN
    REVOKE ALL ON zv_audit_log FROM zveltio_audit_purge;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zveltio_rls') THEN
    GRANT UPDATE, DELETE ON zv_audit_log TO zveltio_rls;
  END IF;
END
$$;

-- NOT VALID: rows of users deleted since the UP name ids no "user" row holds.
ALTER TABLE zv_audit_log DROP CONSTRAINT IF EXISTS zv_audit_log_user_id_fkey;
ALTER TABLE zv_audit_log
  ADD CONSTRAINT zv_audit_log_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES "user"(id) ON DELETE SET NULL NOT VALID;
