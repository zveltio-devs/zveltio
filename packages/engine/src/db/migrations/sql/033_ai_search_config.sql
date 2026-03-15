-- 033_ai_search_config.sql
-- Per-collection AI Search configuration table.
-- Enables auto-embedding on create/update for selected fields.

CREATE TABLE IF NOT EXISTS zvd_ai_search_config (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection  TEXT        NOT NULL,
  fields      TEXT[]      NOT NULL DEFAULT '{}',  -- fields to index: ['title', 'description']
  namespace   TEXT        NOT NULL DEFAULT 'default',
  is_enabled  BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(collection, namespace)
);

COMMENT ON TABLE zvd_ai_search_config IS
  'Per-collection configuration for automatic AI embedding generation.';
COMMENT ON COLUMN zvd_ai_search_config.fields IS
  'Array of field names to concatenate for embedding. Empty = all text fields.';

-- DOWN
DROP TABLE IF EXISTS zvd_ai_search_config;
