-- Dashboard sharing/collaboration
CREATE TABLE IF NOT EXISTS zvd_dashboard_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID NOT NULL REFERENCES zv_dashboards(id) ON DELETE CASCADE,
  shared_with_user_id TEXT,
  shared_with_role TEXT,
  permission TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view','edit')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dashboard_id, shared_with_user_id),
  UNIQUE (dashboard_id, shared_with_role)
);

-- Panel execution cache (TTL-based)
CREATE TABLE IF NOT EXISTS zvd_panel_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id UUID NOT NULL REFERENCES zv_panels(id) ON DELETE CASCADE UNIQUE,
  result JSONB NOT NULL DEFAULT '[]',
  row_count INT NOT NULL DEFAULT 0,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  execution_ms INT NOT NULL DEFAULT 0
);

-- Saved named queries library
CREATE TABLE IF NOT EXISTS zvd_insight_saved_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  query TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_public BOOLEAN NOT NULL DEFAULT false,
  use_count INT NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dashboard subscriptions (email reports)
CREATE TABLE IF NOT EXISTS zvd_dashboard_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID NOT NULL REFERENCES zv_dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily','weekly','monthly')),
  day_of_week INT,
  hour_of_day INT NOT NULL DEFAULT 8,
  last_sent_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dashboard_id, user_id)
);

-- Add to dashboards: tags, last_viewed_at
ALTER TABLE zv_dashboards ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE zv_dashboards ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ;
ALTER TABLE zv_dashboards ADD COLUMN IF NOT EXISTS view_count INT NOT NULL DEFAULT 0;

-- Add to panels: last_executed_at, avg_execution_ms
ALTER TABLE zv_panels ADD COLUMN IF NOT EXISTS last_executed_at TIMESTAMPTZ;
ALTER TABLE zv_panels ADD COLUMN IF NOT EXISTS avg_execution_ms INT;
ALTER TABLE zv_panels ADD COLUMN IF NOT EXISTS error_count INT NOT NULL DEFAULT 0;

CREATE INDEX idx_panel_cache_expires ON zvd_panel_cache(expires_at);
CREATE INDEX idx_saved_queries_tags ON zvd_insight_saved_queries USING gin(tags);
