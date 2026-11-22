-- 134_identity_links_write_own_node.sql
--
-- 120 gave `zv_identity_links` the read predicate on both sides:
-- WITH CHECK (zveltio_tenant_scope_ok(tenant_id)). A consolidating parent's
-- visible set holds its subtree, so a link could land in a child tenant from
-- the parent's context, and the reach sentinel (060) did not stop a write.
-- Every tenant-scoped table writes through `zveltio_tenant_write_ok` instead —
-- a row lands in the own node only (060; tenant-manager.ts, tenant_isolation).
-- The engine writes links in the request's own tenant (lib/extensions/
-- directory.ts), which this admits. Re-runnable.

DROP POLICY IF EXISTS tenant_isolation_zv_identity_links ON zv_identity_links;
CREATE POLICY tenant_isolation_zv_identity_links ON zv_identity_links
  USING (zveltio_tenant_scope_ok(tenant_id))
  WITH CHECK (zveltio_tenant_write_ok(tenant_id));

-- DOWN

DROP POLICY IF EXISTS tenant_isolation_zv_identity_links ON zv_identity_links;
CREATE POLICY tenant_isolation_zv_identity_links ON zv_identity_links
  USING (zveltio_tenant_scope_ok(tenant_id))
  WITH CHECK (zveltio_tenant_scope_ok(tenant_id));
