-- Migration: 025_quality
-- AI Data Quality Engine

CREATE TABLE IF NOT EXISTS zv_quality_scans (
  id              UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  collection      TEXT  NOT NULL,
  scan_type       TEXT  NOT NULL DEFAULT 'full',
  status          TEXT  NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','completed','failed')),
  records_scanned INT   NOT NULL DEFAULT 0,
  issues_found    INT   NOT NULL DEFAULT 0,
  triggered_by    TEXT  REFERENCES "user"(id) ON DELETE SET NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS zv_quality_issues (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id     UUID    NOT NULL REFERENCES zv_quality_scans(id) ON DELETE CASCADE,
  collection  TEXT    NOT NULL,
  issue_type  TEXT    NOT NULL,
  severity    TEXT    NOT NULL DEFAULT 'warning'
              CHECK (severity IN ('info','warning','error')),
  record_ids  TEXT[]  NOT NULL DEFAULT '{}',
  field_name  TEXT,
  description TEXT    NOT NULL,
  suggestion  TEXT,
  auto_fixable BOOLEAN NOT NULL DEFAULT false,
  dismissed   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quality_scans_collection ON zv_quality_scans(collection, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_issues_scan      ON zv_quality_issues(scan_id);
CREATE INDEX IF NOT EXISTS idx_quality_issues_active    ON zv_quality_issues(collection) WHERE NOT dismissed;

-- DOWN
DROP INDEX IF EXISTS idx_quality_issues_active;
DROP INDEX IF EXISTS idx_quality_issues_scan;
DROP TABLE IF EXISTS zv_quality_issues;
DROP INDEX IF EXISTS idx_quality_scans_collection;
DROP TABLE IF EXISTS zv_quality_scans;
