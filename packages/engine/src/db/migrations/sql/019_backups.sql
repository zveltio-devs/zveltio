-- Migration: 019_backups
-- Database backup metadata

CREATE TABLE IF NOT EXISTS zv_backups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     TEXT NOT NULL,
  size_bytes   BIGINT,
  status       TEXT NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress', 'completed', 'failed')),
  error        TEXT,
  notes        TEXT,
  created_by   TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zv_backups_status     ON zv_backups(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zv_backups_created_at ON zv_backups(created_at DESC);

-- DOWN
DROP INDEX IF EXISTS idx_zv_backups_created_at;
DROP INDEX IF EXISTS idx_zv_backups_status;
DROP TABLE IF EXISTS zv_backups;
