-- 103_collection_owner_extension.sql
--
-- ADR 0012: an extension declares its collections as schema files, and the
-- engine creates them when a god enables it (or it loads with them unapplied).
-- Who owns a collection was never recorded: it was inferred from manifests,
-- which is the claim machinery the migration wave removes. The engine writes the
-- owning extension here, in the transaction that creates the collection, and
-- nowhere else. NULL = the instance's own collection (Studio, schema apply).

ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS owner_extension TEXT;

COMMENT ON COLUMN zvd_collections.owner_extension IS
  'The extension that declared this collection, written by the engine when it creates it. NULL = an instance collection. Instance schema export leaves owned collections out.';

-- DOWN
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS owner_extension;
