-- 118_webhook_event_id.sql
--
-- A webhook delivery is a pg-boss job enqueued with the write (ADR 0035). Each
-- event has an id, one per write and the same for every subscriber and retry,
-- and a sequence value taken in the write's transaction after the row.
--
-- `event_id` makes a delivery row one per webhook and event, however often its
-- job runs: the job upserts on (webhook_id, event_id). Rows written before have
-- NULL there, and a unique index admits any number of NULLs.
--
-- The sequence is read by the engine's own role (`asEngineRole`, as pg-boss's
-- INSERT is), which owns it: `zveltio_rls` is granted nothing on it.

ALTER TABLE zvd_webhook_deliveries ADD COLUMN IF NOT EXISTS event_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS zvd_webhook_deliveries_event
  ON zvd_webhook_deliveries (webhook_id, event_id);

CREATE SEQUENCE IF NOT EXISTS zv_change_event_seq;

-- DOWN

DROP SEQUENCE IF EXISTS zv_change_event_seq;
DROP INDEX IF EXISTS zvd_webhook_deliveries_event;
ALTER TABLE zvd_webhook_deliveries DROP COLUMN IF EXISTS event_id;
