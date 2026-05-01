-- Schema branch review requests
CREATE TABLE IF NOT EXISTS zvd_branch_review_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       UUID NOT NULL,
  requested_by    TEXT NOT NULL,
  reviewer_id     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','changes_requested','rejected')),
  message         TEXT,
  reviewer_note   TEXT,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Branch review comments
CREATE TABLE IF NOT EXISTS zvd_branch_comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   UUID NOT NULL,
  author_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  change_ref  TEXT,  -- optional reference to a specific change in branch.changes
  resolved    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE zv_schema_branches ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT NULL CHECK (review_status IN ('pending','approved','changes_requested','rejected'));
ALTER TABLE zv_schema_branches ADD COLUMN IF NOT EXISTS review_requested_by TEXT;
ALTER TABLE zv_schema_branches ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_branch_reviews ON zvd_branch_review_requests(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_branch_comments ON zvd_branch_comments(branch_id, created_at DESC);
