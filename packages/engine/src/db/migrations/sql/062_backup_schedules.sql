-- Migration: 062_backup_schedules
-- Promotes the operations/backup extension into core. The base zv_backups table
-- already lives in 019_backups; here we add schedules + integrity tracking.

CREATE TABLE IF NOT EXISTS zv_backup_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL DEFAULT '0 2 * * *',
  retention_count INT NOT NULL DEFAULT 7,
  storage_destination TEXT NOT NULL DEFAULT 'local' CHECK (storage_destination IN ('local','s3','both')),
  s3_bucket TEXT,
  s3_prefix TEXT,
  notify_on_failure BOOLEAN NOT NULL DEFAULT true,
  notify_emails TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  next_run_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_backup_integrity_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes BIGINT,
  checksum_md5 TEXT,
  is_valid BOOLEAN,
  error TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_backup_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  s3_bucket TEXT,
  s3_key TEXT,
  size_bytes BIGINT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('in_progress','completed','failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_backup_schedules_active ON zv_backup_schedules(is_active, next_run_at);
CREATE INDEX IF NOT EXISTS idx_zv_backup_integrity_backup ON zv_backup_integrity_checks(backup_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_zv_backup_uploads_backup   ON zv_backup_uploads(backup_id, created_at DESC);
