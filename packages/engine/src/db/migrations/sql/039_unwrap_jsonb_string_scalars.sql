-- 039_unwrap_jsonb_string_scalars.sql
--
-- Two jsonb columns hold rows written as a jsonb STRING containing JSON text,
-- because the writer bound `JSON.stringify(v)` (with or without `::jsonb`) on
-- Bun.SQL, which types that parameter as json: `jsonb_typeof` says `string`,
-- `col->'k'` is NULL and `col ? 'k'` is false.
--
--   zv_saved_queries.config   POST /api/saved-queries (fixed in the engine)
--   zv_audit_log.metadata     compliance/gdpr and auth/ldap audit writes
--                             (fixed in those extensions; the rows are here)
--
-- The writers are fixed; this repairs the rows already written. Only a string
-- whose text is a JSON object or array is unwrapped — these columns hold
-- objects, so nothing that is meant to be a string is touched. A row whose text
-- does not parse is left as it is rather than failing the upgrade.
--
-- Re-runnable: an unwrapped row is no longer a string and is not selected.

CREATE OR REPLACE FUNCTION pg_temp.zv_unwrap(t text) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

UPDATE zv_saved_queries
   SET config = pg_temp.zv_unwrap(config #>> '{}')
 WHERE jsonb_typeof(config) = 'string'
   AND left(ltrim(config #>> '{}'), 1) IN ('{', '[')
   AND pg_temp.zv_unwrap(config #>> '{}') IS NOT NULL;

UPDATE zv_audit_log
   SET metadata = pg_temp.zv_unwrap(metadata #>> '{}')
 WHERE jsonb_typeof(metadata) = 'string'
   AND left(ltrim(metadata #>> '{}'), 1) IN ('{', '[')
   AND pg_temp.zv_unwrap(metadata #>> '{}') IS NOT NULL;

-- DOWN

-- Deliberately a no-op: re-wrapping objects into strings would only restore
-- the defect.
SELECT 1;
