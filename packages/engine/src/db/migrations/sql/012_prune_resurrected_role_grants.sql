-- 012_prune_resurrected_role_grants.sql
--
-- The rows #451 stopped creating, removed from the instances that already have
-- them.
--
-- The Casbin adapter's `removePolicy` compared v0..v3 unconditionally. That is
-- right for a `p` rule (sub, dom, obj, act — four values) and wrong for every
-- `g` rule, which carries three: the fourth comparison became `v3 = NULL`,
-- never true in SQL, so the DELETE removed nothing. Casbin drops the rule from
-- the in-memory model regardless, so revocation looked like it worked, the
-- audit line said it worked, and it did — until the next policy load.
--
--     granted owner        → table: tenant_owner
--     demoted to member    → table: tenant_member, tenant_owner
--       in memory now: owner=false member=true
--     after a restart      → owner=true  member=true
--
-- The effect rule is `some(where p.eft == allow)`, so once the old row is back
-- the widest grant wins: a demoted owner is an owner again after any restart,
-- while `zv_tenant_users.role` still reads `member` and the UI agrees with the
-- column rather than with the enforcer. #451 fixed the comparison. Every
-- instance that ever removed a member or changed one's role still holds the
-- rows it failed to delete, and they are live at every boot.
--
-- WHAT THIS DELETES, AND WHAT IT DELIBERATELY DOES NOT
--
-- `zv_tenant_users` is the durable fact; a tenant role grant is derived from it
-- (routes/tenants.ts says so where it grants one). So a `g` row naming one of
-- the four membership grades, in a real tenant, for a real user, that the
-- membership table does not agree with, is a row no current fact supports.
--
-- Four exclusions, each of which would otherwise delete a legitimate grant:
--
--   1. Only `tenant_owner|admin|member|viewer`. An invitation may carry a role
--      name that is NOT a membership grade — `manager` is offered by the invite
--      API — and `routes/auth.ts` deliberately stores such a member as `member`
--      while granting `tenant_manager`. That divergence is by design and is not
--      drift. Anything outside the four is left alone.
--   2. Only rows whose domain is a real tenant. God grants and role-inheritance
--      edges use domain `*` (`routes/users.ts`, `routes/permissions.ts`,
--      `routes/admin/permission-routes.ts`); none of them are membership.
--   3. Only rows whose v0 is a real user. In a `g` row v0 may be another ROLE —
--      that is how inheritance is expressed — and a role has no membership.
--   4. Only three-value rows (v3..v5 NULL), the shape `g` actually has.
--
-- Deleted rows are copied to `zvd_permissions_pruned_012` first. A DELETE of
-- authorization rows should be reversible by someone who did not run it, and
-- the table also answers the question this migration cannot: whether any of the
-- resurrections had been acted on.

CREATE TABLE IF NOT EXISTS zvd_permissions_pruned_012 (
  id          uuid PRIMARY KEY,
  ptype       text NOT NULL,
  v0          text,
  v1          text,
  v2          text,
  v3          text,
  v4          text,
  v5          text,
  created_at  timestamptz,
  membership  text,          -- the grade the membership table held, NULL if none
  pruned_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE zvd_permissions_pruned_012 IS
  'Role grants removed by migration 012 because no membership supported them. '
  'Kept so the deletion is reversible and auditable; safe to drop once reviewed.';

DO $$
DECLARE
  pruned bigint;
BEGIN
  WITH stale AS (
    SELECT p.*, tu.role AS membership
      FROM zvd_permissions p
      LEFT JOIN zv_tenant_users tu
        ON tu.user_id = p.v0
       AND tu.tenant_id::text = p.v2
     WHERE p.ptype = 'g'
       AND p.v1 IN ('tenant_owner', 'tenant_admin', 'tenant_member', 'tenant_viewer')
       AND p.v3 IS NULL AND p.v4 IS NULL AND p.v5 IS NULL
       -- A real tenant, which also excludes the '*' domain without special-casing it.
       AND EXISTS (SELECT 1 FROM zv_tenants t WHERE t.id::text = p.v2)
       -- A real user, so role-inheritance edges are never candidates.
       AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = p.v0)
       -- The membership does not name THIS grade: either it names another one
       -- (a demotion whose old row survived) or there is none (a removal whose
       -- rows survived).
       AND (tu.role IS NULL OR 'tenant_' || tu.role <> p.v1)
  ), saved AS (
    INSERT INTO zvd_permissions_pruned_012
      (id, ptype, v0, v1, v2, v3, v4, v5, created_at, membership)
    SELECT id, ptype, v0, v1, v2, v3, v4, v5, created_at, membership FROM stale
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  DELETE FROM zvd_permissions d
   USING saved s
   WHERE d.id = s.id;

  GET DIAGNOSTICS pruned = ROW_COUNT;

  IF pruned > 0 THEN
    RAISE NOTICE '012: pruned % resurrected tenant role grant(s); copies in zvd_permissions_pruned_012', pruned;
  END IF;
END $$;

-- DOWN
-- Restore what was pruned, then drop the record of it. This is a real reversal:
-- the rows are put back exactly as they were, ids included, so an enforcer
-- reload after a rollback sees the state this migration found.
INSERT INTO zvd_permissions (id, ptype, v0, v1, v2, v3, v4, v5, created_at)
SELECT id, ptype, v0, v1, v2, v3, v4, v5, created_at
  FROM zvd_permissions_pruned_012
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS zvd_permissions_pruned_012;
