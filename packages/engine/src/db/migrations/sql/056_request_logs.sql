CREATE TABLE IF NOT EXISTS zv_request_logs (
  id          BIGSERIAL PRIMARY KEY,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  user_id     TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON zv_request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_path ON zv_request_logs(path);
CREATE INDEX IF NOT EXISTS idx_request_logs_status ON zv_request_logs(status);
