-- Four lists of flow step types, all different, none compared to another.
--
--   this CHECK constraint  : run_script, send_email, webhook, query_db,
--                            condition, transform, delay, send_notification,
--                            export_collection                        (9)
--   flow-executor's switch : query_db, run_script, send_email, webhook,
--                            send_notification, export_collection,
--                            ai_decision                              (7)
--   flow-step-schemas.ts   : twelve, of which eight never execute
--   the Studio's builder   : six, three of which never execute
--
-- Two consequences, in opposite directions:
--
--   `condition`, `transform` and `delay` are STORABLE and never execute. Until
--   now the executor's `default` arm returned the previous step's output and
--   reported success, so a flow built around a condition ran green and did
--   nothing — and its run history said it worked. That is fixed in the executor;
--   this stops new ones being created.
--
--   `ai_decision` is the reverse: the executor implements it and this CHECK
--   refuses to store it, so the feature could not be used at all.
--
-- The constraint now names exactly what `EXECUTABLE_STEP_TYPES` lists, which is
-- derived from the switch that runs. A unit test asserts those two stay equal.
--
-- NOT VALID on purpose. Existing rows carrying `condition`, `transform` or
-- `delay` are left alone: an install that has been running such a flow for
-- months should not have its migration fail, and those steps now fail loudly at
-- execution instead of silently succeeding — which is the outcome that matters.
-- New rows are checked from here on.

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

-- DOWN
ALTER TABLE zv_flow_steps DROP CONSTRAINT IF EXISTS zv_flow_steps_type_check;
ALTER TABLE zv_flow_steps
  ADD CONSTRAINT zv_flow_steps_type_check
  CHECK (type IN (
    'run_script', 'send_email', 'webhook', 'query_db', 'condition',
    'transform', 'delay', 'send_notification', 'export_collection'
  ))
  NOT VALID;
