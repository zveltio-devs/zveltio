-- 048_import_logs_extension_owned.sql
--
-- `zv_import_logs` was created twice with two vocabularies: by the engine in
-- 001 (`file_format`, `success_rows`, `error_rows`, status `processing`) and by
-- the `data/import` extension (`format`, `imported_rows`, `failed_rows`, status
-- `running`). The engine's `/api/import` route is gone, so the extension is now
-- the table's only writer and its vocabulary is the one that should survive.
--
-- This is the EXPAND half only: add the extension's columns where they are
-- missing and carry the engine-era data across. The CONTRACT half — dropping
-- `file_format`, `processed_rows`, `success_rows`, `error_rows` and `options`,
-- and narrowing the status CHECK to the extension's five values — deliberately
-- waits for a later release.
--
-- Why the wait: during a rolling upgrade an instance still running the previous
-- engine serves `/api/import` and both reads those columns and writes status
-- `processing`. Dropping them in the same release that deletes the route breaks
-- that instance for the length of the rollout. Every dead column is
-- `NOT NULL DEFAULT`, so leaving them costs the extension nothing — its inserts
-- never mention them and the defaults fill them in.

-- No-op on the extension's own shape; fills in the engine-shaped table.
ALTER TABLE zv_import_logs
  ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'csv',
  ADD COLUMN IF NOT EXISTS failed_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imported_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS errors JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS filename TEXT;

-- Backfill from the engine vocabulary, guarded so this also runs on a database
-- that only ever had the extension's shape.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'zv_import_logs' AND column_name = 'file_format'
  ) THEN
    EXECUTE $q$
      UPDATE zv_import_logs
      SET format = file_format
      WHERE (format IS NULL OR format = 'csv')
        AND file_format IS NOT NULL
        AND file_format <> ''
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'zv_import_logs' AND column_name = 'error_rows'
  ) THEN
    EXECUTE $q$
      UPDATE zv_import_logs
      SET failed_rows = error_rows
      WHERE failed_rows = 0 AND error_rows IS NOT NULL AND error_rows <> 0
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'zv_import_logs' AND column_name = 'success_rows'
  ) THEN
    EXECUTE $q$
      UPDATE zv_import_logs
      SET imported_rows = success_rows
      WHERE imported_rows = 0 AND success_rows IS NOT NULL AND success_rows <> 0
    $q$;
  END IF;
END $$;

-- `format` lost its CHECK along the way: the extension declared the union in
-- its 001, then re-added the column without it in 003_engine_shaped_table, and
-- ADD COLUMN IF NOT EXISTS above inherits that weaker shape. Restoring it means
-- the column carries the same meaning on a virgin install and an upgrade, and
-- schema-codegen emits the union rather than a bare string.
--
-- NOT VALID on purpose, and not only to keep the lock short: the backfill above
-- copies `file_format`, whose vocabulary included `xlsx`. Validating would force
-- a choice between failing the migration and rewriting those rows to 'csv',
-- and 'csv' would be a lie about what was imported. NOT VALID constrains every
-- future write — the only writer left is the extension, which never emits
-- `xlsx` — while leaving historical rows to say what actually happened.
ALTER TABLE zv_import_logs DROP CONSTRAINT IF EXISTS zv_import_logs_format_check;
ALTER TABLE zv_import_logs
  ADD CONSTRAINT zv_import_logs_format_check
  CHECK (format IN ('csv', 'json', 'ndjson')) NOT VALID;

-- DOWN
ALTER TABLE zv_import_logs DROP CONSTRAINT IF EXISTS zv_import_logs_format_check;
