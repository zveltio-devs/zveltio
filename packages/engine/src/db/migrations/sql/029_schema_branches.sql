-- Migration 029: Schema Branches
-- Supports isolated schema branching for safe schema testing

CREATE TABLE IF NOT EXISTS zv_schema_branches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  base_schema  TEXT NOT NULL DEFAULT 'public',
  branch_schema TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'closed')),
  changes      JSONB NOT NULL DEFAULT '[]',
  created_by   TEXT,
  merged_by    TEXT,
  merged_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_schema)
);

CREATE INDEX IF NOT EXISTS idx_schema_branches_status ON zv_schema_branches(status);
CREATE INDEX IF NOT EXISTS idx_schema_branches_created ON zv_schema_branches(created_at DESC);

-- DOWN
DROP INDEX IF EXISTS idx_schema_branches_created;
DROP INDEX IF EXISTS idx_schema_branches_status;
DROP TABLE IF EXISTS zv_schema_branches;
