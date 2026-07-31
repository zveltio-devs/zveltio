-- Pin the artifact digest an extension was actually installed from.
--
-- The download path already verifies the registry's declared SHA-256 and the
-- registry's signature. Both compare against what the registry is serving
-- TODAY: a registry that re-publishes different content under an existing
-- version passes them, because it declares and signs the new bytes honestly.
-- Only a record of what was installed catches a version whose contents changed.
--
-- The rule is "the same version is always the same bytes". A genuinely new
-- version carries a new digest and re-pins, which is visible to the
-- administrator as a version change.
ALTER TABLE zv_extension_registry
  ADD COLUMN IF NOT EXISTS installed_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS installed_version TEXT;

COMMENT ON COLUMN zv_extension_registry.installed_sha256 IS
  'SHA-256 of the archive this extension was installed from. Re-downloading the same installed_version must produce the same digest.';
