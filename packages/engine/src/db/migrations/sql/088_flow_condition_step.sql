-- 088_flow_condition_step.sql
--
-- The flow executor implements `condition` now: a CEL expression over the
-- run's `trigger` data and the previous step's `output`, evaluated by the same
-- compiler and deadline as validation expression rules (lib/validation-engine.ts).
-- The CHECK on zv_flow_steps.type lists exactly what the executor runs
-- (EXECUTABLE_STEP_TYPES; src/tests/unit/flow-step-types.test.ts compares the
-- two), so the type joins it here.
--
-- NOT VALID, as before: a row stored under a type the executor never ran stays
-- readable and fails its run by name instead of blocking this migration.

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
    'ai_decision',
    'condition'
  ))
  NOT VALID;

-- DOWN
-- The engine before this migration does not run `condition`. Rows already
-- stored keep their type (NOT VALID) and fail their run as not implemented.
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
    'ai_decision'
  ))
  NOT VALID;
