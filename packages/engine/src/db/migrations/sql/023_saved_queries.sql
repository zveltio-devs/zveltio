-- Migration: 023_saved_queries
-- Saved visual query builder configurations

CREATE TABLE IF NOT EXISTS zv_saved_queries (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT    NOT NULL,
  description TEXT,
  collection  TEXT    NOT NULL,
  config      JSONB   NOT NULL DEFAULT '{}',
  is_shared   BOOLEAN NOT NULL DEFAULT false,
  created_by  TEXT    REFERENCES "user"(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_queries_user       ON zv_saved_queries(created_by);
CREATE INDEX IF NOT EXISTS idx_saved_queries_collection ON zv_saved_queries(collection);
CREATE INDEX IF NOT EXISTS idx_saved_queries_shared     ON zv_saved_queries(is_shared) WHERE is_shared = true;

-- DOWN
DROP INDEX IF EXISTS idx_saved_queries_shared;
DROP INDEX IF EXISTS idx_saved_queries_collection;
DROP INDEX IF EXISTS idx_saved_queries_user;
DROP TABLE IF EXISTS zv_saved_queries;
