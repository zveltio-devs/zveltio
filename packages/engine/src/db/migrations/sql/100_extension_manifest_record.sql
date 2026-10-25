-- 100_extension_manifest_record.sql
--
-- What an extension claims — its v1 `resources` and `sensitiveResources`, the
-- collections its actions are gated on — was read from its manifest.json on
-- every create, drop, purge and boot. Files gone with the registry row kept
-- (a soft uninstall whose files were removed, a replica's empty disk) made the
-- claim unknown, and every reader failed closed for good: no collection could be
-- created or dropped, a purge refused, the sensitive-default repair waited.
--
-- The engine keeps the manifest it last read for the extension on god's row
-- (tenant_id IS NULL), so the claim lives and dies with that row: a soft
-- uninstall keeps it, a purge deletes it. Written at install, enable, update and
-- load, and at boot from disk where the files can be read (resource-grants.ts).
-- NULL until then: the claim is unknown, as a missing manifest was.

ALTER TABLE zv_extension_registry ADD COLUMN IF NOT EXISTS manifest jsonb;

COMMENT ON COLUMN zv_extension_registry.manifest IS
  'The extension''s manifest.json as the engine last read it, on god''s row only. What it claims (resources, sensitiveResources, actions) is read from here, not from disk. NULL = never read: the claim is unknown.';

-- DOWN
ALTER TABLE zv_extension_registry DROP COLUMN IF EXISTS manifest;
