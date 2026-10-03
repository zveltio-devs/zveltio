-- 041_audit_log_tenant_index.sql
--
-- NO TRANSACTION
--
-- The index half of 040: a tenant's recent activity (`tenant_id = $t ORDER BY
-- created_at DESC LIMIT n`, what `ctx.internals.readAuditActivity` issues).
-- CONCURRENTLY, so audit writes keep flowing during the build on a log that has
-- been growing for years, which is why this is its own file (as 022 is for 021).
--
-- A failed CONCURRENTLY build leaves an INVALID index that `IF NOT EXISTS`
-- would then skip, so a retry drops it first.

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_audit_log_tenant_created;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_audit_log_tenant_created
  ON zv_audit_log (tenant_id, created_at DESC);

-- DOWN

DROP INDEX IF EXISTS idx_zv_audit_log_tenant_created;
