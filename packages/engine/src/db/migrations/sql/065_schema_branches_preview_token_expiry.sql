-- Preview environment token expiry and rotation support
ALTER TABLE zv_schema_branches
  ADD COLUMN IF NOT EXISTS preview_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preview_token_rotated_at TIMESTAMPTZ;

-- Default TTL: 7 days for existing active preview tokens
UPDATE zv_schema_branches
  SET preview_expires_at = preview_enabled_at + INTERVAL '7 days'
  WHERE preview_enabled = true AND preview_expires_at IS NULL AND preview_enabled_at IS NOT NULL;

-- Index for expiry cleanup job
CREATE INDEX IF NOT EXISTS idx_branches_preview_expires
  ON zv_schema_branches(preview_expires_at)
  WHERE preview_enabled = true;

-- DOWN
DROP INDEX IF EXISTS idx_branches_preview_expires;
ALTER TABLE zv_schema_branches
  DROP COLUMN IF EXISTS preview_expires_at,
  DROP COLUMN IF EXISTS preview_token_rotated_at;
