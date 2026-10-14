-- 071_extension_forward_approvals.sql
--
-- 070 stored the operator's credential-forwarding approval as a column on the
-- extension's instance-wide `zv_extension_registry` row. An extension loaded
-- from ZVELTIO_EXTENSIONS or ZVELTIO_EXTENSIONS_PATH has no such row, so it
-- could never be approved and its worker never received the credentials its
-- manifest asks for, however much the operator wanted it to.
--
-- The approval now has a table of its own keyed by extension name, which every
-- extension has whether or not the registry knows it. 070's approvals move over;
-- uninstall still clears the approval (marketplace uninstall deletes this row).
--
-- 070's column stays, unread: during a rolling upgrade a replica still on 070
-- writes it, and dropping it would fail that replica's installs. It goes with
-- the GA squash.
--
-- Instance-wide, like the registry: an extension is installed per instance.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS zv_extension_forward_approvals (
  name        text PRIMARY KEY,
  approved    jsonb NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE zv_extension_forward_approvals IS
  'Manifest forwardCredentials an operator approved, per extension, as {route: [header, ...]}. The worker receives credential headers only when the manifest map is a subset of this one. No row = none approved.';

INSERT INTO zv_extension_forward_approvals (name, approved)
  SELECT name, approved_forward_credentials FROM zv_extension_registry
   WHERE tenant_id IS NULL AND approved_forward_credentials IS NOT NULL
ON CONFLICT (name) DO NOTHING;

COMMENT ON COLUMN zv_extension_registry.approved_forward_credentials IS
  'Superseded by zv_extension_forward_approvals (migration 071); no longer read.';

-- DOWN
UPDATE zv_extension_registry r SET approved_forward_credentials = a.approved
  FROM zv_extension_forward_approvals a
 WHERE r.name = a.name AND r.tenant_id IS NULL;
COMMENT ON COLUMN zv_extension_registry.approved_forward_credentials IS
  'Manifest forwardCredentials an operator approved, as {route: [header, ...]}. The worker receives credential headers only when the manifest map is a subset of this one. NULL = none approved.';
DROP TABLE IF EXISTS zv_extension_forward_approvals;
