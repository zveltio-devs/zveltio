-- 135_audit_log_created_at_fixed.sql
--
-- ADR 0060 decisions 3 and 4: an audit row's time is the database's, not the
-- writer's.
--
-- The request role (`zveltio_rls`) could INSERT a row with any `created_at`.
-- The retention purge walks each chain in seq order and stops at the first row
-- still inside the window (lib/runtime/garbage-collector.ts), so one row dated
-- in the future kept every older row of its tenant past the window for good;
-- a row dated in the past read as old in the trail. The engine writes NOW()
-- (lib/audit.ts insertRow), so only a bug or an injection reached either.
--
-- A BEFORE INSERT trigger now sets `created_at := now()` for every role that
-- is not the table owner (or a member of it, a superuser included): the owner
-- is the migration and restore identity, and an import it runs keeps its
-- timestamps. A restore of the built-in backup (`gunzip -c | psql`, plain
-- pg_dump) loads the data before it creates any trigger, so it fires neither
-- this one nor the chain's.
--
-- The chain trigger (129) is AFTER INSERT and deferred to COMMIT: it hashes the
-- row as stored, after this one set its time.
--
-- Re-runnable.

CREATE OR REPLACE FUNCTION zveltio_audit_created_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT pg_has_role(current_user,
                     (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS zv_audit_log_created_at ON zv_audit_log;
CREATE TRIGGER zv_audit_log_created_at BEFORE INSERT ON zv_audit_log
  FOR EACH ROW EXECUTE FUNCTION zveltio_audit_created_at();

-- DOWN

DROP TRIGGER IF EXISTS zv_audit_log_created_at ON zv_audit_log;
DROP FUNCTION IF EXISTS zveltio_audit_created_at();
