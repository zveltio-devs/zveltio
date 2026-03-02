-- Migration: 030_rls_tenant_guc
-- Configures the PostgreSQL GUC (Global User Configuration) parameter required for
-- Row-Level Security tenant isolation.
--
-- The middleware sets: SET LOCAL "zveltio.current_tenant" = '<tenant-uuid>'
-- RLS policies check: current_setting('zveltio.current_tenant', true)
--
-- Setting a database-level default ('') ensures new connections have an empty
-- tenant value rather than NULL/error, so RLS denies all rows by default
-- (empty string ≠ any valid UUID → secure by default).
--
-- The DO block gracefully degrades when the DB user is not a superuser.

DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET "zveltio.current_tenant" TO ''''',
    current_database()
  );
EXCEPTION WHEN others THEN
  RAISE NOTICE
    'zveltio: Could not set database-level GUC default for zveltio.current_tenant '
    '(superuser required). RLS will still work — current_setting() returns NULL safely. '
    'Error: %', SQLERRM;
END;
$$;
