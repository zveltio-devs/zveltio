-- 066_audit_log_own_node_writes.sql
--
-- `audit_log_tenant_or_instance` (040) is FOR ALL: USING the visible set, WITH
-- CHECK the own node. WITH CHECK sees only the new row, so a parent unit that
-- reads its subtree could DELETE its children's audit trail, or UPDATE a child's
-- row into its own node and delete it from there (B09). Two RESTRICTIVE policies
-- hold UPDATE and DELETE of an existing row to the own node.
--
-- With no tenant set they stand aside: the retention purge runs that way across
-- every firm (`withEveryTenant`), bounded by the read reach as before, and the
-- instance rows (`tenant_id IS NULL`) are only visible there.
--
-- Every other `tenant_isolation*` table gets the same two policies from the boot
-- reconcilers (`applyOwnNodeWrites`, lib/tenancy/tenant-manager.ts), which visit
-- them on every boot; this table they never visit. The DOWN takes them all.

-- Re-runnable.

DROP POLICY IF EXISTS tenant_own_node_update ON zv_audit_log;
CREATE POLICY tenant_own_node_update ON zv_audit_log AS RESTRICTIVE FOR UPDATE
  USING (zveltio_tenant_write_ok(tenant_id)
         OR (SELECT NULLIF(current_setting('zveltio.current_tenant', true), '') IS NULL));

DROP POLICY IF EXISTS tenant_own_node_delete ON zv_audit_log;
CREATE POLICY tenant_own_node_delete ON zv_audit_log AS RESTRICTIVE FOR DELETE
  USING (zveltio_tenant_write_ok(tenant_id)
         OR (SELECT NULLIF(current_setting('zveltio.current_tenant', true), '') IS NULL));

-- DOWN

-- Every table's, not only this one's: the reconcilers added the rest, and the
-- engine before 066 does not know them. A rollback further back that drops a
-- `tenant_id` column (042's DOWN does, on junctions) is refused while a policy
-- still names it.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT tablename, policyname FROM pg_policies
     WHERE schemaname = 'public'
       AND policyname IN ('tenant_own_node_update', 'tenant_own_node_delete')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END
$$;
