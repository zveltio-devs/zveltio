-- 044_ai_query.sql
-- AI Query history and saved queries (Text-to-SQL)

CREATE TABLE IF NOT EXISTS zv_ai_queries (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  prompt        TEXT        NOT NULL,
  generated_sql TEXT,
  result_count  INT,
  execution_ms  INT,
  ai_analysis   TEXT,
  chart_config  JSONB,
  is_saved      BOOLEAN     NOT NULL DEFAULT false,
  title         TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_queries_user ON zv_ai_queries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_queries_saved ON zv_ai_queries(user_id) WHERE is_saved = true;

-- DOWN
DROP INDEX IF EXISTS idx_ai_queries_saved;
DROP INDEX IF EXISTS idx_ai_queries_user;
DROP TABLE IF EXISTS zv_ai_queries;
