-- 058_collection_permissions.sql
--
-- Collection permissions, decided by the database (roadmap R1).
--
-- `checkPermission(user, collection, action)` was consulted only by the
-- application, so a path that skipped it — a new route, an extension's query, a
-- side table — read and wrote freely inside the tenant. This is the function the
-- per-collection policies call (`applyTenantRLS` → `applyCollectionPermissions`);
-- it reads what the request published and nothing else, so it is one lookup per
-- statement (the policies wrap it in a scalar subquery: an InitPlan, computed
-- once).
--
-- The engine resolves the caller's permissions exactly as `checkPermission`
-- does (`effectivePermissions`: role chains, the tenant and `*` domains, the
-- column role) and publishes the answer as `zveltio.collection_grants` —
-- `,<collection>:<action>,` entries, `<collection>:*` for every action, `*:<act>`
-- for an API key's wildcard collection — with `zveltio.collection_all` for the
-- `('*','*')` grant a tenant admin holds. One definition, Casbin's; the database
-- checks the set the engine computed, so the two cannot drift apart.
--
-- A statement passes when ANY of these holds:
--
--   1. `zveltio.rls_bypass` is on and the action is `read` — `data:view_all`
--      (a god holds it too), an API key with rls_bypass: the exemption the row
--      rules honour, which is about SEEING rows. It writes nothing: the setting
--      cannot tell a god from a view_all holder, so a god's writes come from
--      `zveltio.collection_all` (5), which the engine publishes for a god.
--   2. The collection is named in `zveltio.system_collections` — an extension
--      inside `ctx.internals.asSystem` (capability `data:system`, audited) — or
--      the setting holds `*`: a job of an extension with `data:system`, which
--      the engine marks when it enters the tenant (extensions cannot pass `*`).
--   3. No actor, and not an extension's statement — the engine's own work: boot,
--      reconcilers, jobs. An extension's statement with no actor gets nothing
--      here; its jobs act through `asSystem`.
--   4. The statement runs as a role in `zveltio_coll_exempt` — an extension the
--      operator listed in ZVELTIO_COLLECTION_RLS_EXEMPT, until it is adapted.
--   5. There is an actor, and the published grants hold the action.
--
-- An extension's statement is told apart by the role it runs as: every one runs
-- inside a role window as `zveltio_ext*` / `zveltio_extb_*` / `zveltio_wrk_*` /
-- `zveltio_worker` (ext-db-role.ts). The engine's login role is granted SET on
-- `zveltio_ext`, so membership would not tell them apart; the name does.
--
-- Not SECURITY DEFINER: it reads settings and `current_user`, nothing else.
-- An extension's statement with no actor gets `false` unless asSystem or the
-- exemption admits it; the engine's own statement with no actor gets `true`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_coll_exempt') THEN
    BEGIN
      CREATE ROLE zveltio_coll_exempt NOLOGIN;
    EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
      RAISE NOTICE 'zveltio_coll_exempt not created (%): ZVELTIO_COLLECTION_RLS_EXEMPT will have no effect', SQLERRM;
    END;
  END IF;
END
$$;

-- plpgsql, not SQL, on purpose: a SQL function is inlined into every plan that
-- uses it, regex and catalog subquery included, and that measured +90 µs per
-- statement (20 000 re-planned primary-key reads, Postgres 18). As plpgsql it is
-- an opaque call the policy's scalar subquery runs once per statement: +20 µs,
-- under Block K's bar. The cheap answers return first; the role checks last.
CREATE OR REPLACE FUNCTION zveltio_collection_allows(coll text, act text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
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

GRANT EXECUTE ON FUNCTION zveltio_collection_allows(text, text) TO PUBLIC;

-- DOWN

-- CASCADE takes the four `zv_coll_*` policies on every collection table with
-- it: they call the function, and without it they could not be evaluated. The
-- boot reconciler recreates them when the migration runs again.
DROP FUNCTION IF EXISTS zveltio_collection_allows(text, text) CASCADE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_coll_exempt') THEN
    BEGIN
      DROP ROLE zveltio_coll_exempt;
    EXCEPTION WHEN insufficient_privilege OR dependent_objects_still_exist THEN
      RAISE NOTICE 'zveltio_coll_exempt kept (%)', SQLERRM;
    END;
  END IF;
END
$$;
