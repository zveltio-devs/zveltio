-- 119_flow_run_event_id.sql
--
-- A data-triggered flow is a pg-boss job enqueued with the write (ADR 0035,
-- decision 6). Its run row carries the write's event id, the same one the
-- webhook jobs of that write carry (118).
--
-- The job inserts its run keyed by (flow_id, event_id): a job delivered again
-- finds the row and does not execute the flow a second time, since a step that
-- sends mail or calls HTTP is not idempotent. Manual and cron runs have no
-- event and keep NULL there, and a unique index admits any number of NULLs.

ALTER TABLE zv_flow_runs ADD COLUMN IF NOT EXISTS event_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS zv_flow_runs_event
  ON zv_flow_runs (flow_id, event_id);

-- DOWN

DROP INDEX IF EXISTS zv_flow_runs_event;
ALTER TABLE zv_flow_runs DROP COLUMN IF EXISTS event_id;
