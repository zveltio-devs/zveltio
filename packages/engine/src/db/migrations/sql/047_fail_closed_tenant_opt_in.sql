-- 047_fail_closed_tenant_opt_in.sql
--
-- Opt-in fail-closed tenant visibility when the current_tenant GUC is unset.
--
-- Default (flag off): GUC unset → match the default tenant (029 semantics).
-- With zveltio.fail_closed_tenant = 'on': GUC unset → no rows (true fail-closed).
--
-- Operators enable via env ZVELTIO_FAIL_CLOSED_TENANT=1 at boot (engine sets the
-- database GUC). Do not flip this on by default — single-tenant installs and
-- contextless jobs (migrations, GC) rely on the 029 fallback until they all set
-- an explicit tenant or use a privileged system role.

CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      false
    ELSE
      row_tenant = '00000000-0000-0000-0000-000000000001'::uuid
  END
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      false
    ELSE
      row_tenant = '00000000-0000-0000-0000-000000000001'
  END
$$;

COMMENT ON FUNCTION zveltio_tenant_scope_ok(uuid) IS
  'Tenant row visibility. When zveltio.fail_closed_tenant=on and current_tenant '
  'is unset, returns false (no rows). Otherwise matches 029 default-tenant fallback. '
  'See migration 047 + ZVELTIO_FAIL_CLOSED_TENANT.';

COMMENT ON FUNCTION zveltio_tenant_scope_ok(text) IS
  'TEXT overload of zveltio_tenant_scope_ok(uuid). Same fail-closed opt-in. See 047.';
