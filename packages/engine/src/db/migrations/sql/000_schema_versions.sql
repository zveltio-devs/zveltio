-- Migration 000: Schema Version Tracking
-- Must be the first migration applied (000 prefix sorts before 001)

CREATE TABLE IF NOT EXISTS zv_schema_versions (
  id             SERIAL PRIMARY KEY,
  version        INTEGER NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  filename       TEXT NOT NULL,
  checksum       TEXT NOT NULL,
  applied_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  engine_version TEXT,
  execution_ms   INTEGER,
  rolled_back_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zv_schema_versions_version
  ON zv_schema_versions(version DESC);

-- Also create the legacy zv_migrations table for backward compatibility
CREATE TABLE IF NOT EXISTS zv_migrations (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert version 0 as baseline
INSERT INTO zv_schema_versions
  (version, name, filename, checksum, engine_version)
VALUES
  (0, 'baseline', '000_schema_versions.sql', 'baseline', '2.0.0')
ON CONFLICT (version) DO NOTHING;

-- DOWN
DROP INDEX IF EXISTS idx_zv_schema_versions_version;
DROP TABLE IF EXISTS zv_schema_versions;
DROP TABLE IF EXISTS zv_migrations;
