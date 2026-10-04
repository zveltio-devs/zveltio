-- 054_instance_heartbeat.sql
--
-- One row per running engine in single-instance mode
-- (`ZVELTIO_SINGLE_INSTANCE=1`, production without Valkey).
--
-- Without Valkey, a revoked permission or a demoted god reaches only the
-- process that made the change. That is correct on one process and a leak on
-- two. Each instance writes its row here about every 10 seconds; an instance
-- that sees a live row started after its own stops serving
-- (`lib/runtime/single-instance.ts`). The newest wins, so a rolling or
-- blue-green deploy ends on the new process, and an accidental second replica
-- leaves exactly one serving.
--
-- Not tenant data: engine processes, read and written by the engine only.
-- Times come from the database clock, so two hosts with drifting clocks still
-- agree on which instance is newer.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS zv_instances (
  instance_id uuid PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen   timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- DOWN

DROP TABLE IF EXISTS zv_instances;
