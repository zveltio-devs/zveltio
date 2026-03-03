-- 034_ai_decision_step.sql
-- Documents the ai_decision step type added to the flow executor.

COMMENT ON COLUMN zvd_flow_steps.type IS
  'Step types: query_db, run_script, send_email, webhook, send_notification, export_collection, ai_decision';
