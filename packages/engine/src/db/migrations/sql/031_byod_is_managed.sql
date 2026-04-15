-- 031_byod_is_managed.sql
-- Collection-level governance flags.
--
-- is_managed   — false = BYOD table, Zveltio will NOT run ALTER TABLE on it.
-- source_type  — 'table' = introspected from external DB; 'collection' = created by Zveltio.
-- is_system    — true for core collections shipped with the engine (contacts, orgs, etc).
-- schema_locked — true blocks removing columns (but ADD is still allowed).
--
-- is_system/schema_locked are required before ensureCoreCollections() (which runs
-- at boot) can INSERT core collection rows into zvd_collections.

ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS is_managed    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS source_type   TEXT    NOT NULL DEFAULT 'collection';
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS is_system     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS schema_locked BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN zvd_collections.is_managed    IS 'false = BYOD table, Zveltio will NOT alter schema';
COMMENT ON COLUMN zvd_collections.source_type   IS 'collection = created by Zveltio, table = introspected BYOD';
COMMENT ON COLUMN zvd_collections.is_system     IS 'true for engine-shipped core collections';
COMMENT ON COLUMN zvd_collections.schema_locked IS 'true blocks removing columns (ADD still allowed)';

-- DOWN
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS schema_locked;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS is_system;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS source_type;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS is_managed;
