-- Tracking table for native extension schedules (S2-05).
--
-- Each invocation of a schedule's handler — successful, failed, retried, or
-- pushed to DLQ — gets a row here. Admins can query for failures, replay DLQ
-- entries, and audit when extension jobs actually ran.

CREATE TABLE IF NOT EXISTS zv_extension_schedule_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_name  TEXT NOT NULL,
  schedule_name   TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL,            -- 'running' | 'ok' | 'failed' | 'dlq'
  attempt         INT NOT NULL DEFAULT 1,
  error_message   TEXT,
  trace_id        TEXT
);

CREATE INDEX IF NOT EXISTS idx_zv_ext_schedule_runs_ext_sched
  ON zv_extension_schedule_runs (extension_name, schedule_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_zv_ext_schedule_runs_status
  ON zv_extension_schedule_runs (status)
  WHERE status IN ('failed', 'dlq');

-- DOWN
DROP INDEX IF EXISTS idx_zv_ext_schedule_runs_status;
DROP INDEX IF EXISTS idx_zv_ext_schedule_runs_ext_sched;
DROP TABLE IF EXISTS zv_extension_schedule_runs;
