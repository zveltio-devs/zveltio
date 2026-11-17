-- 124_remove_flow_query_db.sql
--
-- ADR 0058 decision 1 (DR-05): no caller-written SQL runs in the engine. The
-- flow `query_db` step ran its author's SQL; RLS reads the `zveltio.*`
-- settings, which that SQL could rewrite with `set_config` in its own
-- transaction and so read another tenant's rows, and without
-- `zveltio_flow_reader` it ran as the connection role (a superuser on a stock
-- install). The executor no longer runs it.
--
-- zv_flow_steps.type: the CHECK lists exactly what the executor runs
-- (EXECUTABLE_STEP_TYPES; src/tests/unit/flow-step-types.test.ts compares the
-- two). NOT VALID, as in 088 and 113: a stored `query_db` step is kept — its
-- SQL is the author's, and deleting it would lose their work — and is inert.
-- The executor refuses a flow holding one before its first step, naming the
-- step (REMOVED_STEP_TYPES in flow-executor.ts); the routes refuse creating
-- one (400).
--
-- NOT VALID still checks every write: a stored `query_db` step refuses an
-- update, and so does deleting an earlier step of its flow, which renumbers it.
-- Delete the `query_db` step first, or change its type in the same update.
-- Rewriting the stored type to a marker was the alternative; it changes a value
-- the author wrote and needs a marker the CHECK admits, for nothing this does
-- not give.

ALTER TABLE zv_flow_steps DROP CONSTRAINT IF EXISTS zv_flow_steps_type_check;
ALTER TABLE zv_flow_steps
  ADD CONSTRAINT zv_flow_steps_type_check
  CHECK (type IN (
    'run_script',
    'send_email',
    'webhook',
    'send_notification',
    'export_collection',
    'condition'
  ))
  NOT VALID;

-- DOWN
-- The engine before this migration runs `query_db`. Stored steps were never
-- changed, so they run again as they did.
ALTER TABLE zv_flow_steps DROP CONSTRAINT IF EXISTS zv_flow_steps_type_check;
ALTER TABLE zv_flow_steps
  ADD CONSTRAINT zv_flow_steps_type_check
  CHECK (type IN (
    'query_db',
    'run_script',
    'send_email',
    'webhook',
    'send_notification',
    'export_collection',
    'condition'
  ))
  NOT VALID;
