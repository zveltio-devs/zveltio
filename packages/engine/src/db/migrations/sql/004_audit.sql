-- Migration 004: Audit trail (revisions)

-- Revisions system — tracks all changes to records
CREATE TABLE IF NOT EXISTS zv_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  data JSONB NOT NULL DEFAULT '{}',
  delta JSONB,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_revisions_record
  ON zv_revisions(collection, record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zv_revisions_user
  ON zv_revisions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zv_revisions_created
  ON zv_revisions(created_at DESC);

-- Immutable audit log (security)
CREATE TABLE IF NOT EXISTS zvd_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'read', 'update', 'delete')),
  old_data JSONB,
  new_data JSONB,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_audit_log_table ON zvd_audit_log(table_name);
CREATE INDEX IF NOT EXISTS idx_zvd_audit_log_record ON zvd_audit_log(record_id);
CREATE INDEX IF NOT EXISTS idx_zvd_audit_log_created ON zvd_audit_log(created_at DESC);

-- DOWN
DROP INDEX IF EXISTS idx_zvd_audit_log_created;
DROP INDEX IF EXISTS idx_zvd_audit_log_record;
DROP INDEX IF EXISTS idx_zvd_audit_log_table;
DROP TABLE IF EXISTS zvd_audit_log;
DROP INDEX IF EXISTS idx_zv_revisions_created;
DROP INDEX IF EXISTS idx_zv_revisions_user;
DROP INDEX IF EXISTS idx_zv_revisions_record;
DROP TABLE IF EXISTS zv_revisions;
