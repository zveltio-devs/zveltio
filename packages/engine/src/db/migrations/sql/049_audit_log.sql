-- 049: Centralized audit log for security events
CREATE TABLE IF NOT EXISTS zv_audit_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT        NOT NULL,
  user_id      TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  resource_id  TEXT,
  resource_type TEXT,
  metadata     JSONB       NOT NULL DEFAULT '{}',
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user    ON zv_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_type    ON zv_audit_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON zv_audit_log(created_at DESC);

-- Auto-cleanup: run periodically via cron/pg_cron
-- DELETE FROM zv_audit_log WHERE created_at < NOW() - INTERVAL '90 days';
