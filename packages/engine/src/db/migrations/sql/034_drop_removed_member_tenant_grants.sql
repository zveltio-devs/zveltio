-- 034_drop_removed_member_tenant_grants.sql
--
-- A user removed from a tenant keeps no role in that tenant — whoever removes
-- them — and the roles earlier removals left behind are pruned.
--
-- `DELETE /api/tenants/:id/members/:userId` revoked the four `tenant_*` grades
-- and nothing else. Every other `g <user> <role> <tenant>` row stayed: an
-- invited `manager` (routes/auth.ts grants a non-grade invite role as itself),
-- a custom role. `checkPermission` kept honouring those roles' `p` rules in the
-- tenant, a re-added member silently got them back, and a tenant flow notifying
-- the role kept writing to the former member — `getUsersForRole` counts a grant
-- in the tenant's own domain without asking for membership. SCIM
-- deprovisioning (`auth/scim`) deletes the membership row by raw SQL and left
-- every grant, the grade included. Migration 012 pruned only the grades.
--
-- WHAT IS PRUNED
--
-- `zv_tenant_users` is the durable fact a tenant-domain grant derives from
-- (012 makes the same call). A `g` row is pruned when its v0 is a real user,
-- its domain a real tenant, and that user holds no membership row there. Kept:
--
--   - the `*` domain (not a tenant) and the default tenant: membership there is
--     implicit (`tenant-membership.ts` lets every account in), so a missing row
--     is not evidence;
--   - role→role edges: v0 is a role, never a "user" id;
--   - anything that is not the three-value `g` shape.
--
-- Copies go to `zvd_permissions_pruned_034` first, as in 012 and 033, so the
-- DELETE is reversible by someone who did not run it.
--
-- AND NO NEW ONES
--
-- One engine route and one extension remove members, and anyone at a psql
-- prompt can. As 017 did for "user", the rule lives on the table: deleting a
-- membership row deletes the user's `g` rows in that tenant's domain.
--
-- DEFERRED, to commit. SCIM deletes the row and then, in the same transaction,
-- hands the user to `internals.deleteUser`, whose enforcer removes their rows on
-- the POOL. An immediate trigger would hold those rows locked by the open
-- transaction and the pool's DELETE would wait on a transaction that is waiting
-- on it. At commit the enforcer's removal has already landed and this finds
-- nothing. The membership is re-checked then, so a row deleted and re-inserted
-- in one transaction keeps its grants.
--
-- RUNNING ENGINES
--
-- The route also removes the grants through the enforcer, which updates the
-- live model and tells the replicas. Rows only this trigger (or the prune)
-- removes reach a running enforcer on the reconcile tick (`reconcilePolicies`,
-- 30-60 s), which compares the table's fingerprint with what it loaded.

CREATE TABLE IF NOT EXISTS zvd_permissions_pruned_034 (
  id          uuid PRIMARY KEY,
  ptype       text NOT NULL,
  v0          text,
  v1          text,
  v2          text,
  v3          text,
  v4          text,
  v5          text,
  created_at  timestamptz,
  pruned_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE zvd_permissions_pruned_034 IS
  'Tenant-domain role grants of users with no membership in that tenant, removed '
  'by migration 034. Kept so the deletion is reversible and auditable; safe to '
  'drop once reviewed.';

WITH stale AS (
  SELECT p.*
    FROM zvd_permissions p
   WHERE p.ptype = 'g'
     AND p.v3 IS NULL AND p.v4 IS NULL AND p.v5 IS NULL
     AND p.v2 <> '00000000-0000-0000-0000-000000000001'
     AND EXISTS (SELECT 1 FROM zv_tenants t WHERE t.id::text = p.v2)
     AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = p.v0)
     AND NOT EXISTS (SELECT 1 FROM zv_tenant_users tu
                      WHERE tu.tenant_id::text = p.v2 AND tu.user_id = p.v0)
), saved AS (
  INSERT INTO zvd_permissions_pruned_034 (id, ptype, v0, v1, v2, v3, v4, v5, created_at)
  SELECT id, ptype, v0, v1, v2, v3, v4, v5, created_at FROM stale
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
DELETE FROM zvd_permissions d
 USING saved s
 WHERE d.id = s.id;

-- SECURITY INVOKER, as 017: every role that may delete a membership row
-- (the owner, `zveltio_rls`) holds DELETE on zvd_permissions.
CREATE OR REPLACE FUNCTION zveltio_drop_removed_member_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.zv_tenant_users
                  WHERE tenant_id = OLD.tenant_id AND user_id = OLD.user_id) THEN
    DELETE FROM public.zvd_permissions
     WHERE ptype = 'g' AND v0 = OLD.user_id AND v2 = OLD.tenant_id::text;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS zv_drop_removed_member_grants ON zv_tenant_users;
CREATE CONSTRAINT TRIGGER zv_drop_removed_member_grants
  AFTER DELETE ON zv_tenant_users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION zveltio_drop_removed_member_grants();

-- DOWN
DROP TRIGGER IF EXISTS zv_drop_removed_member_grants ON zv_tenant_users;
DROP FUNCTION IF EXISTS zveltio_drop_removed_member_grants();

INSERT INTO zvd_permissions (id, ptype, v0, v1, v2, v3, v4, v5, created_at)
SELECT id, ptype, v0, v1, v2, v3, v4, v5, created_at
  FROM zvd_permissions_pruned_034
ON CONFLICT DO NOTHING;

DROP TABLE IF EXISTS zvd_permissions_pruned_034;
