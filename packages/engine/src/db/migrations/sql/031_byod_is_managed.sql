-- 031_byod_is_managed.sql
-- BYOD (Bring Your Own Database): marks collections as managed or unmanaged.
-- is_managed = false → table is external (BYOD), Zveltio will NOT run ALTER TABLE on it.
-- source_type = 'table' → introspected from external DB; 'collection' = created by Zveltio.

ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS is_managed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'collection';

COMMENT ON COLUMN zvd_collections.is_managed IS 'false = BYOD table, Zveltio will NOT alter schema';
COMMENT ON COLUMN zvd_collections.source_type IS 'collection = created by Zveltio, table = introspected BYOD';
