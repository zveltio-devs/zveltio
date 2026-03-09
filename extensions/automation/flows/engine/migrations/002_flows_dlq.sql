-- Flows retry config + DLQ — idempotent migration

-- Retry configuration per flow
ALTER TABLE zv_flows
  ADD COLUMN IF NOT EXISTS retry_config JSONB NOT NULL DEFAULT '{
    "max_attempts": 3,
    "backoff": "exponential",
    "initial_delay_ms": 1000,
    "max_delay_ms": 30000
  }';

-- Idempotency + attempt tracking on runs
ALTER TABLE zv_flow_runs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_runs_idempotency
  ON zv_flow_runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Dead Letter Queue: flows that failed all retry attempts
CREATE TABLE IF NOT EXISTS zv_flow_dlq (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id       UUID NOT NULL REFERENCES zv_flows(id) ON DELETE CASCADE,
  run_id        UUID NOT NULL,
  step_index    INTEGER NOT NULL DEFAULT -1,
  error_message TEXT,
  error_stack   TEXT,
  payload       JSONB,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_dlq_flow ON zv_flow_dlq(flow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flow_dlq_run ON zv_flow_dlq(run_id);
