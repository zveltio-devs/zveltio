-- 040_audit_log_tenant.sql
--
-- `zv_audit_log` gets `tenant_id` and a policy.
--
-- It carried every firm's activity with nothing to say whose, so RLS had no
-- column to bind and the only boundary was the instance-admin guard on the one
-- route that read it. No reader could be handed "this tenant's activity": the
-- dashboard extension showed the whole instance's trail to every tenant.
--
-- The column defaults to the writing transaction's tenant, read from the GUC
-- every policy reads. Outside a tenant transaction — boot, the god-audit
-- middleware, logins, tenant administration, the nightly collector — there is
-- none, and the row is NULL: an instance-level event. The existing rows are
-- exactly that (nothing recorded whose they were), so they stay NULL: the column
-- is added bare and the default set after, which touches no existing row.
--
-- Not a `tenant_isolation_*` policy, on purpose. The boot reconciler adopts every
-- policy of that name, backfills NULL `tenant_id` to the default tenant and
-- rewrites the predicate to the plain shape — it would hand every instance-level
-- event to the default firm and drop the clause below on the next boot.
--
-- Instance-level rows are visible, and writable, only where no tenant is the
-- transaction's subject (`zveltio.current_tenant` empty). Every tenant
-- transaction publishes one — a member's, an admin's, god's — so none of them
-- reads or forges an instance row; the instance audit routes read outside one,
-- with every firm published (`withEveryTenant`). An empty setting rather than
-- an unset one is what a pooled connection carries after a tenant transaction
-- (set_config(…, true) leaves ''), so NULLIF covers both spellings.
--
-- No foreign key on `tenant_id`, like collection tables: an audit INSERT must
-- not be able to fail on the tenant row, and a purge deletes these with the rest.

ALTER TABLE zv_audit_log ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE zv_audit_log
  ALTER COLUMN tenant_id SET DEFAULT NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid;

ALTER TABLE zv_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE zv_audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_tenant_or_instance ON zv_audit_log;
CREATE POLICY audit_log_tenant_or_instance ON zv_audit_log
  AS PERMISSIVE FOR ALL TO public
  USING (
    tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[])
    OR (tenant_id IS NULL
        AND (SELECT NULLIF(current_setting('zveltio.current_tenant', true), '') IS NULL))
  )
  WITH CHECK (
    zveltio_tenant_write_ok(tenant_id)
    OR (tenant_id IS NULL
        AND NULLIF(current_setting('zveltio.current_tenant', true), '') IS NULL)
  );

-- DOWN

DROP POLICY IF EXISTS audit_log_tenant_or_instance ON zv_audit_log;
ALTER TABLE zv_audit_log NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_audit_log DISABLE ROW LEVEL SECURITY;
ALTER TABLE zv_audit_log DROP COLUMN IF EXISTS tenant_id;
