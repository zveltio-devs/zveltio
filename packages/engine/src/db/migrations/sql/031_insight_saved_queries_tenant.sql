-- 031_insight_saved_queries_tenant.sql
--
-- Insights saved queries belong to a tenant.
--
-- Migration 019 tenant-scoped `zv_saved_queries` and explained why: "sharing
-- must be per-ORGANIZATION, so scope every access by tenant_id". It did not
-- touch `zvd_insight_saved_queries`, a different table with a nearly identical
-- name holding the same kind of thing — user-authored SQL, marked public or
-- private, executable by id.
--
-- So `POST /insights/saved-queries/:id/execute` looked the row up by id alone,
-- allowed it if `is_public`, and ran the text. Any authenticated user could
-- execute any other tenant's public saved query, and the SQL itself ran on the
-- global pool with no tenant context, so it returned every tenant's rows.
--
-- Two layers of the same hole: the row was reachable across tenants, and the
-- query it contained was unscoped when it ran. This closes the first; the route
-- change closes the second by executing under the caller's tenant.
--
-- `zvd_insight_dashboards` already has the column, which is why panels were
-- looked up correctly and only their SQL leaked. One table in a pair got the
-- fix and its twin did not.

ALTER TABLE zvd_insight_saved_queries
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE zvd_insight_saved_queries
   SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;

ALTER TABLE zvd_insight_saved_queries
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid
  );

ALTER TABLE zvd_insight_saved_queries
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_zvd_insight_saved_queries_tenant
  ON zvd_insight_saved_queries (tenant_id);

-- Route handlers scope by tenant explicitly; this is the second lock, on the
-- host's shared predicate (migration 029) and bound by the enforcement role
-- (migration 030).
ALTER TABLE zvd_insight_saved_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE zvd_insight_saved_queries FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_zvd_insight_saved_queries
  ON zvd_insight_saved_queries;
CREATE POLICY tenant_isolation_zvd_insight_saved_queries
  ON zvd_insight_saved_queries
  USING (zveltio_tenant_scope_ok(tenant_id))
  WITH CHECK (zveltio_tenant_scope_ok(tenant_id));
