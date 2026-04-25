-- Performance indexes for common query patterns identified via EXPLAIN ANALYZE
-- All created CONCURRENTLY to avoid locking production tables during migration

-- Point queries on revisions by record (used in record detail views)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_revisions_record_id
  ON zv_revisions(record_id);

-- User activity timeline (audit log filtered by user + time desc)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_user_time
  ON zv_audit_log(user_id, created_at DESC);

-- Active flow lookup by trigger type (used on every data write to find matching flows)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flows_active_trigger
  ON zv_flows(is_active, (trigger->>'type'))
  WHERE is_active = true;

-- Casbin policy lookup by resource + action (v1=resource, v2=action, ptype='p')
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_permissions_resource_action
  ON zvd_permissions(v1, v2)
  WHERE ptype = 'p';

-- API key lookup by owner + active status (used in key management UI)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_keys_created_by
  ON zv_api_keys(created_by, is_active);

-- Edge function logs time-range queries (log explorer per function)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_edge_fn_logs_time
  ON zv_edge_function_logs(created_at DESC);

-- Request logs by path + status (used in analytics / error dashboards)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_request_logs_path_status
  ON zv_request_logs(path, status_code, created_at DESC);

-- DOWN
DROP INDEX CONCURRENTLY IF EXISTS idx_revisions_record_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_user_time;
DROP INDEX CONCURRENTLY IF EXISTS idx_flows_active_trigger;
DROP INDEX CONCURRENTLY IF EXISTS idx_permissions_resource_action;
DROP INDEX CONCURRENTLY IF EXISTS idx_api_keys_created_by;
DROP INDEX CONCURRENTLY IF EXISTS idx_edge_fn_logs_time;
DROP INDEX CONCURRENTLY IF EXISTS idx_request_logs_path_status;
