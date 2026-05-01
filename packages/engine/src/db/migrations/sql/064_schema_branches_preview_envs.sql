-- Preview environments: a branch can be "activated" as a live preview
-- with an isolated PostgreSQL schema reachable via X-Preview-Token header.
ALTER TABLE zv_schema_branches
  ADD COLUMN IF NOT EXISTS preview_enabled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS preview_token    TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS preview_schema   TEXT,
  ADD COLUMN IF NOT EXISTS preview_enabled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_branches_preview_token ON zv_schema_branches(preview_token)
  WHERE preview_token IS NOT NULL;
