-- 121_role_grants_marker.sql
--
-- A marker that tells the engine at boot whether this database was restored
-- without its roles.
--
-- `zveltio_rls`, `zveltio_worker` and `zveltio_flow_reader` are cluster
-- objects: `pg_dump` does not carry them, while it does carry every GRANT that
-- names them. Restored onto a new server where they do not exist, each of those
-- GRANTs fails and is gone for good. Recreating the roles at boot does not bring
-- the grants back: only the dump knows them all (EXECUTE on
-- `zveltio_media_used_bytes`, SELECT on `zvv__revisions`, the default
-- privileges, the narrow roles' schema USAGE), so the engine booted with them
-- missing and reported tenant RLS as enforced.
--
-- This function does nothing. The engine grants EXECUTE on it to each of those
-- roles the first time it sees the role, and names the role in its COMMENT
-- (`enforceRoleGrantsMarker`, lib/tenancy/tenant-manager.ts). The dump carries
-- both. A role the comment names that lacks EXECUTE here lost its grants in a
-- restore, and the engine refuses to start (docs/platform/disaster-recovery.md
-- §4 Scenario B: create the roles first, then restore).

CREATE OR REPLACE FUNCTION zveltio_role_grants_marker() RETURNS void
  LANGUAGE sql AS $$ SELECT $$;

REVOKE ALL ON FUNCTION zveltio_role_grants_marker() FROM PUBLIC;

-- DOWN

DROP FUNCTION IF EXISTS zveltio_role_grants_marker();
