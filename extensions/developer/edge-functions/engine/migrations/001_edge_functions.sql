-- Edge function definitions
CREATE TABLE IF NOT EXISTS zv_edge_functions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,    -- URL-safe identifier
  display_name TEXT NOT NULL,
  description  TEXT,
  code         TEXT NOT NULL DEFAULT '', -- TypeScript/JS source
  runtime      TEXT NOT NULL DEFAULT 'bun',
  http_method  TEXT NOT NULL DEFAULT 'POST',  -- GET, POST, ANY
  path         TEXT NOT NULL,            -- /api/fn/<name> auto-assigned
  is_active    BOOLEAN NOT NULL DEFAULT true,
  timeout_ms   INTEGER NOT NULL DEFAULT 30000,
  env_vars     JSONB NOT NULL DEFAULT '{}',   -- {KEY: "value"} injected
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Invocation log
CREATE TABLE IF NOT EXISTS zv_edge_function_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id  UUID NOT NULL REFERENCES zv_edge_functions(id) ON DELETE CASCADE,
  status       INTEGER NOT NULL,         -- HTTP status
  duration_ms  INTEGER,
  request_body TEXT,
  response_body TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fn_logs_function ON zv_edge_function_logs(function_id, created_at DESC);
