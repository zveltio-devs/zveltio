-- Row-level security on the four tables Better-Auth owns.
--
-- `user`, `session`, `account` and `verification` have had no RLS in any
-- migration. That is why C-14 and C-10 — two separate string guards that had no
-- rule for unprefixed table names — reached live session tokens and password
-- hashes across every tenant rather than one. Both guards are fixed; this is the
-- layer that makes the next miss survivable instead of total.
--
-- These tables have no `tenant_id`, so this is NOT tenant scoping. It is a
-- default of "no rows for anybody the policy does not name", which is the
-- correct posture for tables that hold credentials.
--
-- `user` is deliberately NOT in the list, and the reason is what it holds:
-- id, name, email, role, timestamps — no credentials. The password lives in
-- `account`, the bearer token in `session`. Meanwhile the engine's own features
-- read `user` constantly through the tenant-scoped handle: `/api/me`, the user
-- list, notification fan-out, the health probe. Enabling RLS there took
-- `/api/me` to a 500 — measured, not predicted — and the containment gained
-- would have been over the least sensitive of the five.
--
-- So the line is drawn at the credentials: `zveltio_rls` keeps SELECT on `user`
-- and nothing at all on the other four. Extensions get nothing on any of them
-- (migration 043 revokes all five from `zveltio_worker`), because an extension
-- has no business reading the user table either.
--
-- ENABLE, not FORCE, and that distinction is the whole design:
--
--   * RLS does not bind a table's OWNER unless FORCE is set. The engine connects
--     as the role that owns these tables, so Better-Auth's own reads and writes
--     during sign-in, sign-up and session refresh are untouched. Adding FORCE
--     here would lock the product out of its own authentication.
--   * Every other role — `zveltio_rls`, `zveltio_worker`, `zveltio_flow_reader`,
--     anything added later — IS bound, and with no permissive policy present it
--     sees zero rows.
--
-- No policy is created deliberately. A table with RLS enabled and no policy
-- returns nothing to a non-owner, which is exactly the intent; writing
-- `USING (false)` would say the same thing with more to go wrong.
--
-- The grants are the other half. `ensureRlsEnforcementRole` runs at every boot
-- and granted `zveltio_rls` full DML on every table in `public`, so a REVOKE
-- here would be undone by the next start — that loop now skips these five names.
-- The REVOKE below cleans up installs that already ran it.

DO $$
DECLARE
  t record;
  r record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('session', 'account', 'verification', 'twoFactor')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);

    -- Take back what the blanket grant handed out on earlier boots. Only roles
    -- this product creates: a REVOKE aimed at whatever else an operator has
    -- granted would be this migration guessing at their deployment.
    FOR r IN
      SELECT rolname FROM pg_roles
      WHERE rolname IN ('zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader')
    LOOP
      EXECUTE format('REVOKE ALL ON public.%I FROM %I', t.tablename, r.rolname);
    END LOOP;
  END LOOP;
END
$$;

-- DOWN
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('session', 'account', 'verification', 'twoFactor')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$$;
