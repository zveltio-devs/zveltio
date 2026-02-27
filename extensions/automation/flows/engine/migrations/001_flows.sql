-- Automation flows
CREATE TABLE IF NOT EXISTS zv_flows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  trigger     JSONB NOT NULL DEFAULT '{}',   -- {type, collection, event, cron, ...}
  steps       JSONB NOT NULL DEFAULT '[]',   -- [{id, type, config, next, ...}]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Flow execution log
CREATE TABLE IF NOT EXISTS zv_flow_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id     UUID NOT NULL REFERENCES zv_flows(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed
  trigger_data JSONB NOT NULL DEFAULT '{}',
  steps_log   JSONB NOT NULL DEFAULT '[]',  -- [{step_id, status, output, error, started_at, ended_at}]
  error       TEXT,
  started_at  TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flows_active ON zv_flows(is_active);
CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON zv_flow_runs(flow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON zv_flow_runs(status, created_at DESC);
