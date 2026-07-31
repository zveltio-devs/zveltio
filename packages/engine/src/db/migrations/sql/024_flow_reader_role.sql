-- A database role for flow `query_db` steps, with no access to auth tables.
--
-- `query_db` runs operator-authored SQL. It is already read-only (SET
-- TRANSACTION READ ONLY) and scoped to the caller's tenant for collection data
-- — but the tenant GUC only governs `zvd_*` rows. Better-Auth's `session`,
-- `user` and `account` tables have no RLS, so "read-only and tenant-scoped" was
-- true of collection data and of nothing else: `SELECT token FROM "session"`
-- returned every live session on the instance, god sessions included.
--
-- Authorship is now gated (instance admins only), which contains it. This is
-- the actual boundary: Postgres refuses the read regardless of who wrote the
-- query or how it is shaped. Same lesson as the data-modifying CTE that walked
-- through a regex guard — the database enforces, the string check advises.
--
-- The grant is an ALLOWLIST (`zvd_*` collection tables only), not a denylist of
-- sensitive tables. A denylist means every future system table is readable
-- until someone remembers to add it; an allowlist means a new *collection* that
-- is missed becomes unreadable to flows, which surfaces immediately as a broken
-- report rather than silently as a leak.
--
-- Best-effort by design. A managed Postgres where the application user cannot
-- CREATE ROLE would otherwise fail this migration and block the upgrade
-- entirely. When the role is absent the executor logs and falls back to the
-- authorship gate — defence in depth, where the outer layer always holds.
DO $$
DECLARE
  t record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_flow_reader') THEN
    CREATE ROLE zveltio_flow_reader NOLOGIN;
  END IF;

  -- The connecting user must be a member to `SET ROLE` to it.
  EXECUTE format('GRANT zveltio_flow_reader TO %I', current_user);

  GRANT USAGE ON SCHEMA public TO zveltio_flow_reader;

  -- Existing collection tables. New ones are granted by DDLManager at create
  -- time; see grantFlowReaderSelect().
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'zvd\_%'
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO zveltio_flow_reader', t.tablename);
  END LOOP;

  -- Belt and braces: an explicit REVOKE on the tables this exists to protect,
  -- in case a future default-privilege change hands out blanket SELECT.
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename IN ('session', 'user', 'account', 'verification')
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM zveltio_flow_reader', t.tablename);
  END LOOP;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'zveltio_flow_reader not created (insufficient privilege). Flow query_db steps stay gated by authorship only — see 024_flow_reader_role.sql.';
END
$$;
