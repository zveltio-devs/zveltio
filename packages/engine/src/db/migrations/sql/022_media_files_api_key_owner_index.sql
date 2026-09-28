-- 022_media_files_api_key_owner_index.sql
--
-- NO TRANSACTION
--
-- The index half of 021: a key's own listing (`created_by_api_key = $key`,
-- beside `idx_zv_media_files_owner` for sessions) and the SET NULL when a key
-- row goes. CONCURRENTLY, so writes to `zv_media_files` keep flowing during the
-- build, which is why this is its own file (as 014 is for 013).
--
-- A failed CONCURRENTLY build leaves an INVALID index that `IF NOT EXISTS`
-- would then skip, so a retry drops it first.
--
-- The DOWN is plain: `zveltio rollback` runs every DOWN inside a transaction,
-- where DROP INDEX CONCURRENTLY is refused.

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_media_files_created_by_api_key;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_media_files_created_by_api_key
  ON zv_media_files (created_by_api_key) WHERE created_by_api_key IS NOT NULL;

-- DOWN

DROP INDEX IF EXISTS idx_zv_media_files_created_by_api_key;
