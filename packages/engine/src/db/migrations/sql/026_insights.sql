-- Migration: 026_insights
-- Analytics dashboards and panels

CREATE TABLE IF NOT EXISTS zv_dashboards (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT    NOT NULL,
  description TEXT,
  icon        TEXT    NOT NULL DEFAULT 'BarChart',
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_by  TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_panels (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID  NOT NULL REFERENCES zv_dashboards(id) ON DELETE CASCADE,
  name         TEXT  NOT NULL,
  type         TEXT  NOT NULL DEFAULT 'table',
  query        TEXT  NOT NULL DEFAULT '',
  config       JSONB NOT NULL DEFAULT '{}',
  position_x   INT   NOT NULL DEFAULT 0,
  position_y   INT   NOT NULL DEFAULT 0,
  width        INT   NOT NULL DEFAULT 6,
  height       INT   NOT NULL DEFAULT 4,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_panels_dashboard ON zv_panels(dashboard_id, position_y, position_x);

-- DOWN
DROP INDEX IF EXISTS idx_panels_dashboard;
DROP TABLE IF EXISTS zv_panels;
DROP TABLE IF EXISTS zv_dashboards;
