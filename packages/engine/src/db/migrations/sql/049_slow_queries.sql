CREATE TABLE IF NOT EXISTS zv_slow_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query_params JSONB DEFAULT '{}',
  status_code INTEGER,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_slow_queries_duration ON zv_slow_queries(duration_ms DESC);
CREATE INDEX IF NOT EXISTS idx_slow_queries_path ON zv_slow_queries(path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slow_queries_created ON zv_slow_queries(created_at DESC);
-- Auto-purge old records (keep 7 days) — run via pg_cron or manual cleanup
-- DOWN
-- DROP INDEX IF EXISTS idx_slow_queries_created;
-- DROP INDEX IF EXISTS idx_slow_queries_path;
-- DROP INDEX IF EXISTS idx_slow_queries_duration;
-- DROP TABLE IF EXISTS zv_slow_queries;
