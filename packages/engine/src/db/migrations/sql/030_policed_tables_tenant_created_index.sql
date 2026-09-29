-- 030_policed_tables_tenant_created_index.sql
--
-- NO TRANSACTION
--
-- The `(tenant_id, created_at DESC)` index the boot reconciler gives every
-- policed table with a `created_at`, built here first for the ten engine tables
-- 023-029 put under a policy. Migrations run before the reconciler, and it
-- builds by name (`reconcileExtensionTenantRLS`): finding these, it builds
-- nothing. Left to it, each was a plain CREATE INDEX at boot, with writes to
-- `zv_revisions` or `zvd_webhook_deliveries` blocked for the whole build and no
-- lock_timeout on the wait.
--
-- An install that booted beta.70 already has them, and this rebuilds them
-- without blocking writes: a failed CONCURRENTLY build leaves an INVALID index
-- that `IF NOT EXISTS` would then skip for good, so each is dropped first.

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_media_files_tenant_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_media_files_tenant_created
  ON zv_media_files (tenant_id, created_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_media_folders_tenant_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_media_folders_tenant_created
  ON zv_media_folders (tenant_id, created_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_media_tags_tenant_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_media_tags_tenant_created
  ON zv_media_tags (tenant_id, created_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_revisions_tenant_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_revisions_tenant_created
  ON zv_revisions (tenant_id, created_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_import_logs_tenant_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_import_logs_tenant_created
  ON zv_import_logs (tenant_id, created_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_dashboards_tenant_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_dashboards_tenant_created
  ON zv_dashboards (tenant_id, created_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_flows_tenant_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_flows_tenant_created
  ON zv_flows (tenant_id, created_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_zvd_webhooks_tenant_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zvd_webhooks_tenant_created
  ON zvd_webhooks (tenant_id, created_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_zvd_webhook_deliveries_tenant_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zvd_webhook_deliveries_tenant_created
  ON zvd_webhook_deliveries (tenant_id, created_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_environments_tenant_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_environments_tenant_created
  ON zv_environments (tenant_id, created_at DESC);

-- DOWN

-- Deliberately a no-op: the reconciler builds these same indexes on the next
-- boot, so dropping them would only bring back the blocking build this avoids.
SELECT 1;
