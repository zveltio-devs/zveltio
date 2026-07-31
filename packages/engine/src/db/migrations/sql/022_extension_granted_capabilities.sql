-- Record which capabilities an administrator actually consented to.
--
-- The manifest DECLARES capabilities; this column records what was GRANTED.
-- Without the distinction, an extension can ship v1 declaring nothing and v2
-- declaring `db:admin`, and an update hands it cross-tenant database access
-- with nobody deciding anything. Consent has to be stored to be meaningful.
--
-- NULL means "no consent recorded" and is grandfathered at load: every install
-- that predates this column keeps running with what its manifest declares.
-- Refusing those would turn an engine upgrade into an outage for a decision
-- nobody was ever asked to make. Consent is recorded from the next install,
-- enable or approval onwards.
ALTER TABLE zv_extension_registry
  ADD COLUMN IF NOT EXISTS granted_capabilities JSONB;

COMMENT ON COLUMN zv_extension_registry.granted_capabilities IS
  'Capabilities an admin consented to, as a JSON array of strings. NULL = pre-consent install (grandfathered). The effective set at load is granted ∩ declared.';
