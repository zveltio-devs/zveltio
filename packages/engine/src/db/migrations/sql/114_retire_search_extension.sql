-- 114_retire_search_extension.sql
--
-- The `search` extension is retired (owner, 2026-11-07). It synced records to
-- an external Meilisearch or Typesense; full-text search is the engine's own:
-- collections store a `search_vector` with a GIN index and the data API takes
-- `search=`. No 2.x of the extension ships.
--
-- Its registry rows go, as in 110: the loader treats an enabled row whose files
-- are absent as a bundle to fetch, and would download the retired 1.x bundle
-- from the registry. Its migration ledger rows go, as in 111. Its one table,
-- `zv_search_indexes`, held index definitions for the external engine (which
-- fields to index, last sync time); the indexed documents live in that external
-- engine, not here, and are rebuilt from the collections. Nothing reads the
-- table once the extension is gone, so it is dropped.

-- squawk-ignore-file ban-drop-table

DELETE FROM zv_extension_registry WHERE name = 'search';
DELETE FROM zv_migrations WHERE name LIKE 'ext:search:%';
DROP TABLE IF EXISTS zv_search_indexes;

-- DOWN

-- Not reversed: the extension no longer exists to re-enable.
SELECT 1;
