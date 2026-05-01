-- Approval gate flag per branch + global setting
ALTER TABLE zv_schema_branches
  ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT false;

-- Global setting: enforce approval on ALL branches by default
-- Stored in zv_settings key 'schema_branches.require_approval' (boolean, default false)

-- DOWN
ALTER TABLE zv_schema_branches DROP COLUMN IF EXISTS requires_approval;
