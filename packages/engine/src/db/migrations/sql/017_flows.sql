-- Migration: 017_flows
-- Automation flows: triggers, steps, and run history

CREATE TABLE IF NOT EXISTS zv_flows (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  description    TEXT,
  trigger_type   TEXT NOT NULL DEFAULT 'manual'
                   CHECK (trigger_type IN ('manual', 'on_create', 'on_update', 'on_delete', 'cron', 'webhook')),
  trigger_config JSONB NOT NULL DEFAULT '{}',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  last_run_at    TIMESTAMPTZ,
  next_run_at    TIMESTAMPTZ,
  created_by     TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_flow_steps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id    UUID NOT NULL REFERENCES zv_flows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL DEFAULT 0,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL
               CHECK (type IN (
                 'run_script', 'send_email', 'webhook', 'query_db',
                 'condition', 'transform', 'delay',
                 'send_notification', 'export_collection'
               )),
  config     JSONB NOT NULL DEFAULT '{}',
  on_error   TEXT NOT NULL DEFAULT 'stop'
               CHECK (on_error IN ('stop', 'continue', 'retry')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_flow_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id      UUID NOT NULL REFERENCES zv_flows(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'success', 'failed', 'cancelled')),
  trigger_data JSONB,
  output       JSONB,
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zv_flows_active    ON zv_flows(is_active);
CREATE INDEX IF NOT EXISTS idx_zv_flow_steps_flow ON zv_flow_steps(flow_id, step_order);
CREATE INDEX IF NOT EXISTS idx_zv_flow_runs_flow  ON zv_flow_runs(flow_id, started_at DESC);
