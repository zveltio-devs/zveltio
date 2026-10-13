-- 064_drop_duplicate_indexes.sql
--
-- NO TRANSACTION
--
-- Four indexes the beta chain built twice under two names, which the GA
-- baseline (062) carries as it found them: every write to these tables paid
-- for both, and the planner gained nothing from the second.
--
--   idx_zv_revisions_lookup          = idx_zv_revisions_record          (collection, record_id, created_at DESC)
--   idx_audit_log_user_time          = idx_audit_log_user               (user_id, created_at DESC)
--   idx_zv_saved_queries_tenant_id   = idx_zv_saved_queries_tenant      (tenant_id)
--   idx_zv_record_comments_tenant_id = idx_zv_record_comments_tenant    (tenant_id)
--
-- The later of each pair goes. The two `_tenant_id` ones are also what the
-- boot sweep in reconcileExtensionTenantRLS drops; here a fresh install never
-- has them. CONCURRENTLY, so writes to `zv_audit_log` and `zv_revisions` keep
-- flowing.

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_revisions_lookup;
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_user_time;
DROP INDEX CONCURRENTLY IF EXISTS idx_zv_saved_queries_tenant_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_zv_record_comments_tenant_id;

-- DOWN

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_revisions_lookup
  ON zv_revisions (collection, record_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_user_time
  ON zv_audit_log (user_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_saved_queries_tenant_id
  ON zv_saved_queries (tenant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_record_comments_tenant_id
  ON zv_record_comments (tenant_id);
