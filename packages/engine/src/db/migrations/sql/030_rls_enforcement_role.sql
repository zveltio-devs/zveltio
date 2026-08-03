-- A database role that Postgres will actually apply RLS to.
--
-- Everything about tenant isolation in this codebase assumes FORCE ROW LEVEL
-- SECURITY binds the engine's connection. It does not, on a default install.
--
-- `docker-compose.yml` sets `POSTGRES_USER: ${POSTGRES_USER:-zveltio}`, and the
-- official Postgres image creates that user as a SUPERUSER — that is what the
-- variable means to the image's entrypoint. FORCE RLS does not bind superusers,
-- and neither does anything else. So on every stock deployment the isolation
-- policies are commentary: the reconcilers install them, `warnIfDbRoleBypassesRls`
-- prints a warning at boot that scrolls past in the startup log, and every query
-- reads every tenant's rows anyway.
--
-- This is underneath the whole tenant-isolation category of the 2026-08-03
-- audit. Fixing the policies — which the audit asked for and migration 029 did —
-- changes nothing at all while the connection is exempt from them.
--
-- The fix is not to tell operators to reconfigure their database. It is to stop
-- depending on how they configured it: the engine drops to a plain role for the
-- duration of each tenant transaction, so RLS applies whatever the connection
-- happens to be. `withTenantIsolation` issues `SET LOCAL ROLE zveltio_rls`
-- immediately after BEGIN, and the role reverts when the transaction ends.
--
-- The precedent is `zveltio_flow_reader` (migration 024), which does the same
-- thing for `query_db` steps. This applies it to the path every request takes.
--
-- Scope note: schema-management routes (`/api/collections`, `/api/relations`,
-- `/api/schema`, `/api/templates`) deliberately do NOT open a tenant
-- transaction — see TXN_SKIP_PREFIXES — so DDL never runs under this role and
-- keeps the owner's rights. Only tenant DATA access is downgraded, which is
-- exactly the access RLS is meant to govern.
--
-- Best-effort, like 024: a managed Postgres where the application user cannot
-- CREATE ROLE must not fail the migration and block the upgrade. When the role
-- is absent the engine logs at boot and behaves as it does today.
DO $$
DECLARE
  t record;
  s record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_rls') THEN
    -- NOSUPERUSER and NOBYPASSRLS are the entire point; spelled out rather than
    -- left to defaults so a future edit cannot quietly undo it.
    CREATE ROLE zveltio_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- The connecting user must be a member to `SET ROLE` to it.
  EXECUTE format('GRANT zveltio_rls TO %I', current_user);

  GRANT USAGE ON SCHEMA public TO zveltio_rls;

  -- DML on everything the engine reads or writes inside a request. Not DDL:
  -- this role is for data access, and schema changes run outside the tenant
  -- transaction.
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO zveltio_rls', t.tablename);
  END LOOP;

  -- Serial primary keys need the sequence, or every INSERT fails with
  -- "permission denied for sequence".
  FOR s IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO zveltio_rls', s.sequencename);
  END LOOP;

  -- Tables created later — by a collection, or by an extension's migrations —
  -- must be reachable too, or the first write to a new collection fails. Default
  -- privileges apply to objects this role creates from now on.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zveltio_rls', current_user);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT USAGE, SELECT ON SEQUENCES TO zveltio_rls', current_user);
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'zveltio_rls not created (insufficient privilege). If the engine connects as a SUPERUSER, row-level security is NOT enforced — see 030_rls_enforcement_role.sql.';
END
$$;
