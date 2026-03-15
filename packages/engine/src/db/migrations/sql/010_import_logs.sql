-- Migration 010: Data import logs

CREATE TABLE IF NOT EXISTS zv_import_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_format TEXT NOT NULL DEFAULT 'csv'
    CHECK (file_format IN ('csv', 'xlsx', 'json', 'ndjson')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'partial')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  success_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  errors JSONB DEFAULT '[]',
  options JSONB DEFAULT '{}',   -- delimiter, skip_header, mapping, etc.
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zv_import_logs_collection ON zv_import_logs(collection);
CREATE INDEX IF NOT EXISTS idx_zv_import_logs_status ON zv_import_logs(status);
CREATE INDEX IF NOT EXISTS idx_zv_import_logs_created ON zv_import_logs(created_at DESC);

-- DOWN
DROP INDEX IF EXISTS idx_zv_import_logs_created;
DROP INDEX IF EXISTS idx_zv_import_logs_status;
DROP INDEX IF EXISTS idx_zv_import_logs_collection;
DROP TABLE IF EXISTS zv_import_logs;
