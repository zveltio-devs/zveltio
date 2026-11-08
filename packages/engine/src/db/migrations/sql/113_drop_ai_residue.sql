-- 113_drop_ai_residue.sql
--
-- ADR 0027: AI is an opt-in extension and the engine holds no AI code. The
-- engine no longer runs the `ai_decision` flow step or the `ai_task` flow
-- trigger, has no `ai` rate-limit tier, and stops carrying what the `ai` 1.x
-- extension's migrations added to engine-owned tables. ai 2.0 declares
-- collections only and touches none of this.
--
-- zv_flow_steps.type: the CHECK lists exactly what the executor runs
-- (EXECUTABLE_STEP_TYPES; src/tests/unit/flow-step-types.test.ts compares the
-- two). NOT VALID, as in 088: a stored `ai_decision` step stays readable and
-- fails its run by name ("not implemented") instead of blocking this migration.
--
-- zv_flows.trigger_type: ai 1.x widened the CHECK with `ai_task`. Put back the
-- engine's own list. NOT VALID for the same reason: the scheduler claims
-- `cron` rows only, so a stored `ai_task` flow is inert.
--
-- NOT VALID still checks every write: a legacy row (an `ai_decision` step, an
-- `ai_task` flow) refuses an update, and so does deleting an earlier step of
-- its flow, which renumbers it. Delete the legacy row first. Accepted pre-GA
-- (ADR 0027 consequences: flows using `ai_decision` break until C5).
--
-- zvd_collections: ai 1.x added `ai_search_enabled`, `ai_search_field` and
-- `ai_embed_excluded_fields`. Nothing in the engine reads them any more.
--
-- DROPPING WHILE AN OLDER ENGINE RUNS
--
-- The previous engine never read these columns by name (the collection route
-- accepted `aiSearchEnabled` and wrote nothing); a pooled `SELECT *` plan over
-- `zvd_collections` is recycled after migrations (index.ts,
-- `recycleActivePool`). Only an ai 1.x extension still installed would read
-- them, and ai 2.0 replaces it. Pre-GA, no installs to migrate (ADR 0027 §6).

-- squawk-ignore-file ban-drop-column

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

ALTER TABLE zv_flows DROP CONSTRAINT IF EXISTS zv_flows_trigger_type_check;
ALTER TABLE zv_flows
  ADD CONSTRAINT zv_flows_trigger_type_check
  CHECK (trigger_type IN ('manual', 'on_create', 'on_update', 'on_delete', 'cron', 'webhook'))
  NOT VALID;

ALTER TABLE zvd_collections
  DROP COLUMN IF EXISTS ai_search_enabled,
  DROP COLUMN IF EXISTS ai_search_field,
  DROP COLUMN IF EXISTS ai_embed_excluded_fields;

-- The `ai` tier's row (seeded by 001) and any per-firm override of it: no
-- limiter reads them, and `PATCH /api/admin/rate-limits` refuses the tier.
DELETE FROM zv_rate_limit_configs
 WHERE key_prefix IN ('ai', 'tenant:ai')
    OR key_prefix LIKE 'tenant:ai:%'
    OR key_prefix LIKE 'tenant-self:ai:%';

-- DOWN
-- The engine before this migration runs `ai_decision`; the `ai` tier row comes
-- back with its compiled default. The columns and `ai_task` were the ai 1.x
-- extension's to add, and its migrations add them again.
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
INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests, description) VALUES
  ('ai', 60000, 20, 'AI features (chat, search, embeddings)')
ON CONFLICT (key_prefix) DO NOTHING;
