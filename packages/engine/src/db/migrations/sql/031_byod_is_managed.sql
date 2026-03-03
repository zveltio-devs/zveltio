-- 031_byod_is_managed.sql
-- BYOD (Bring Your Own Database): marchează colecțiile ca managed sau unmanaged.
-- is_managed = false → tabelul e extern (BYOD), Zveltio NU va face ALTER TABLE pe el.
-- source_type = 'table' → introspected din DB extern; 'collection' = creat de Zveltio.

ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS is_managed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'collection';

COMMENT ON COLUMN zvd_collections.is_managed IS 'false = BYOD table, Zveltio will NOT alter schema';
COMMENT ON COLUMN zvd_collections.source_type IS 'collection = created by Zveltio, table = introspected BYOD';
