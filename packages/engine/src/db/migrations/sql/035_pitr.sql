-- Migration: 035_pitr
-- PITR (Point-in-Time Recovery) configuration and restore points

CREATE TABLE IF NOT EXISTS zv_pitr_config (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_enabled          BOOLEAN NOT NULL DEFAULT false,
  wal_archive_path    TEXT,
  retention_days      INT NOT NULL DEFAULT 7,
  last_base_backup_at TIMESTAMPTZ,
  last_wal_segment    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO zv_pitr_config (id) VALUES (gen_random_uuid()) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS zv_pitr_restore_points (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  lsn         TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  UUID REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pitr_restore_points_at ON zv_pitr_restore_points(recorded_at DESC);
