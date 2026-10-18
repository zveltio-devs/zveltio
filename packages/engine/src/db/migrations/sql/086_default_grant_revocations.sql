-- 086_default_grant_revocations.sql
--
-- An operator's revoke of a default grant did not last. `materializeDefaultGrants`
-- (lib/tenancy/resource-grants.ts) writes `tenant_member` read/create/update
-- (plus execute on extension resources) and `tenant_viewer` read on every
-- resource, with ON CONFLICT DO NOTHING, at every boot, at every extension load
-- and at collection create. Nothing recorded a deletion, so the row an operator
-- removed through DELETE /api/permissions/policies or the Studio matrix came
-- back on the next boot.
--
-- A row here is that decision: the Casbin adapter writes it in the same
-- statement that deletes a default grant (lib/tenancy/permissions.ts), and
-- deletes it in the same statement that grants the triple again. The
-- materializer skips a triple that has one. Engine cleanup that deletes with
-- its own SQL (collection drop, tenant teardown) writes none; a collection drop
-- deletes the ones recorded for it, as it deletes its grants.
--
-- Instance-wide, like `zvd_permissions`: a default grant is a rule in domain
-- '*', so its revocation is too. No tenant column, no RLS.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS zv_default_grant_revocations (
  role       text NOT NULL,
  resource   text NOT NULL,
  action     text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, resource, action)
);

COMMENT ON TABLE zv_default_grant_revocations IS
  'Default grants (role, ''*'', resource, action) an operator removed; materializeDefaultGrants does not write them again. Granting the triple explicitly deletes the row.';

-- DOWN
DROP TABLE IF EXISTS zv_default_grant_revocations;
