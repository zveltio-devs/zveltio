-- A database role for the worker SQL bridge — the sandbox for extension code
-- the platform has decided NOT to trust.
--
-- The bridge ran under `zveltio_rls`, and `ensureRlsEnforcementRole` grants that
-- role SELECT, INSERT, UPDATE and DELETE on EVERY table in `public`. Better-Auth
-- keeps `user`, `session`, `account`, `verification` and `twoFactor` there, none
-- of them with RLS. So a community extension could read live session tokens and
-- write itself an admin role, and the only thing between it and them was a
-- string check that had no rule for unprefixed tables at all.
--
-- The string check is now an allowlist (worker-sql-policy.ts). This is the
-- boundary underneath it: Postgres refuses regardless of what the query looked
-- like, or of a future gap in the parser. Same lesson migration 024 records for
-- flow `query_db` steps — the database enforces, the string check advises.
--
-- The grant is an ALLOWLIST, deliberately, in 024's words: "A denylist means
-- every future system table is readable until someone remembers to add it."
-- Collections (`zvd_*`) are what extensions exist to work with; everything else
-- is refused because it was never granted.
--
-- DML rather than SELECT: unlike a flow query step, a worker extension writes.
-- RLS still applies — the role is NOSUPERUSER and NOBYPASSRLS, so tenant
-- isolation on `zvd_*` holds exactly as it does for a request.
--
-- Best-effort, like 024: a managed Postgres where the application user cannot
-- CREATE ROLE must not fail the upgrade. When the role is absent the bridge
-- keeps its previous behaviour and the allowlist in worker-sql-policy.ts is the
-- only layer — which is why that layer was fixed first rather than instead.
DO $$
DECLARE
  t record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_worker') THEN
    CREATE ROLE zveltio_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- The connecting user must be a member to `SET ROLE` to it.
  EXECUTE format('GRANT zveltio_worker TO %I', current_user);

  GRANT USAGE ON SCHEMA public TO zveltio_worker;

  -- Collection tables only. New ones are granted at create time; see
  -- grantWorkerSqlAccess() beside grantFlowReaderSelect().
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'zvd\_%'
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO zveltio_worker', t.tablename);
  END LOOP;

  -- Sequences backing those tables, or every INSERT fails on the identity column.
  FOR t IN
    SELECT sequencename FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename LIKE 'zvd\_%'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO zveltio_worker', t.sequencename);
  END LOOP;

  -- Belt and braces, as 024 does: an explicit REVOKE on the tables this exists
  -- to protect, in case a future default-privilege change hands out blanket
  -- access. `twoFactor` is included — it was not in 024's list, and it holds the
  -- second-factor secrets.
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('session', 'user', 'account', 'verification', 'twoFactor')
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM zveltio_worker', t.tablename);
  END LOOP;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'zveltio_worker not created (insufficient privilege). The worker SQL bridge falls back to its previous role — see 043_worker_sql_role.sql.';
END
$$;

-- DOWN
DROP ROLE IF EXISTS zveltio_worker;
