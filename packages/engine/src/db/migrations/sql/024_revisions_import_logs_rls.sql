-- 024_revisions_import_logs_rls.sql
--
-- `zv_revisions` and `zv_import_logs` go under the tenant policy every tenant
-- table has.
--
-- Both got `tenant_id` in 001 and no policy. What kept one firm out of another's
-- audit trail was the `where tenant_id` each reader remembered to write, and
-- `content/drafts` counts a record's revisions without one. A whitelisted RPC
-- function, or any handler that forgets, saw every firm's history.
--
-- Every reader and writer already runs inside the request's tenant transaction:
-- `afterWrite` on `getDb(c)` with the request tenant as `tenant_id`, the
-- `?as_of=` readers, `/api/revisions`, `/api/admin/revisions`, and the two
-- extensions through `ctx.db` or `withTenantIsolation`. None runs on the pool
-- and none is a background job, so nothing loses rows it needs.
--
-- `data/import` already polices `zv_import_logs` under the same name when it is
-- installed (its 002), and the boot reconciler rewrites that policy to the shape
-- below. This makes the table safe without the extension, and either order
-- converges.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zv_revisions', 'zv_import_logs'] LOOP
    -- A NULL tenant_id is invisible to everyone under the policy. 001
    -- backfilled these already; this catches a row written with an explicit NULL.
    EXECUTE format(
      'UPDATE %I SET tenant_id = ''00000000-0000-0000-0000-000000000001''::uuid '
      || 'WHERE tenant_id IS NULL', t);

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- The shape the boot reconciler gives every `tenant_isolation_*` policy
    -- (005: the `(SELECT …)` InitPlan; 004: writes to the own node only).
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_isolation_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO public '
      || 'USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[])) '
      || 'WITH CHECK (zveltio_tenant_write_ok(tenant_id))',
      'tenant_isolation_' || t, t);
  END LOOP;
END $$;

-- DOWN

-- Only `zv_revisions` is undone. `zv_import_logs` keeps its policy: with
-- `data/import` installed it was that extension's before this migration, and
-- dropping it here would strip a table the extension still relies on.
DROP POLICY IF EXISTS tenant_isolation_zv_revisions ON zv_revisions;
ALTER TABLE zv_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_revisions DISABLE ROW LEVEL SECURITY;
