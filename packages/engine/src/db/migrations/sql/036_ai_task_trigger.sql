-- Migration 036: Add 'ai_task' as valid trigger type for zv_flows
-- Idempotent: drops and re-adds constraint

ALTER TABLE zv_flows
  DROP CONSTRAINT IF EXISTS zv_flows_trigger_type_check;

ALTER TABLE zv_flows
  ADD CONSTRAINT zv_flows_trigger_type_check
  CHECK (trigger_type IN ('manual', 'on_create', 'on_update', 'on_delete', 'cron', 'webhook', 'ai_task'));

-- DOWN
ALTER TABLE zv_flows DROP CONSTRAINT IF EXISTS zv_flows_trigger_type_check;
ALTER TABLE zv_flows
  ADD CONSTRAINT zv_flows_trigger_type_check
  CHECK (trigger_type IN ('manual', 'on_create', 'on_update', 'on_delete', 'cron', 'webhook'));
