-- 104_collection_declared_file.sql
--
-- ADR 0012 amendment 1. An extension's collection keeps the row rules, column
-- permissions and validation rules an operator adds; a load manages only the
-- entries the extension's own file declares. `declared_file` is that file as the
-- extension's last apply wrote it: an entry it held and the new version's file
-- lacks is the extension's to remove, any other entry is the operator's.
--
-- `default_grants` false: the file says `defaultGrants: false` (an internal or
-- sensitive collection), and the engine writes no default role grant on it.

ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS declared_file JSONB;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS default_grants BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN zvd_collections.declared_file IS
  'The owning extension''s collection file as its last apply wrote it (ADR 0012). NULL for an instance collection.';
COMMENT ON COLUMN zvd_collections.default_grants IS
  'false: the declaring extension withholds it from the default role grants (ADR 0012, defaultGrants).';

-- DOWN
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS default_grants;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS declared_file;
