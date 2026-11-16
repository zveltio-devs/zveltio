-- 123_fail_closed_tenant_by_default.sql
--
-- DR-03 (ADR 0053 decision 1, owner 2026-11-15): with no tenant context, a
-- query sees NO tenant's rows. Until now it saw the default tenant's — unless
-- `zveltio.fail_closed_tenant` was 'on', which only ZVELTIO_FAIL_CLOSED_TENANT=1
-- wrote, at boot, with ALTER DATABASE.
--
-- The default lives here and not only in the boot step. A setting the engine
-- must write to be safe is unsafe wherever it was not written: a database
-- restored without its `ALTER DATABASE … SET`, a role that may not run that
-- ALTER, a connection opened before boot reached it. So the ABSENT setting now
-- means closed, and only an explicit 'off' (also 'false', '0') — what
-- ZVELTIO_FAIL_CLOSED_TENANT=0 writes — reopens the default-tenant fallback.
-- Any other value, a typo included, stays closed.
--
-- Only the third branch changes; the visible set and the current tenant still
-- decide first, and `zveltio_tenant_write_ok` keeps the reach sentinel (060).
-- PARALLEL SAFE restated on purpose: CREATE OR REPLACE resets what it does not
-- restate (see 003/004). Re-runnable.

CREATE OR REPLACE FUNCTION zveltio_visible_tenants()
RETURNS uuid[]
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.visible_tenants', true), '') IS NOT NULL THEN
      string_to_array(current_setting('zveltio.visible_tenants', true), ',')::uuid[]
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      ARRAY[NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid]
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'on'))
         IN ('off', 'false', '0') THEN
      ARRAY['00000000-0000-0000-0000-000000000001'::uuid]
    ELSE
      ARRAY[]::uuid[]
  END
$$;

CREATE OR REPLACE FUNCTION zveltio_visible_tenants_text()
RETURNS text[]
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.visible_tenants', true), '') IS NOT NULL THEN
      string_to_array(current_setting('zveltio.visible_tenants', true), ',')
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      ARRAY[NULLIF(current_setting('zveltio.current_tenant', true), '')]
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'on'))
         IN ('off', 'false', '0') THEN
      ARRAY['00000000-0000-0000-0000-000000000001']
    ELSE
      ARRAY[]::text[]
  END
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_write_ok(row_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'on'))
         IN ('off', 'false', '0') THEN
      row_tenant = '00000000-0000-0000-0000-000000000001'::uuid
    ELSE
      false
  END
  AND NULLIF(current_setting('zveltio.visible_tenants', true), '')
      IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_write_ok(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'on'))
         IN ('off', 'false', '0') THEN
      row_tenant = '00000000-0000-0000-0000-000000000001'
    ELSE
      false
  END
  AND NULLIF(current_setting('zveltio.visible_tenants', true), '')
      IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'
$$;

-- DOWN

CREATE OR REPLACE FUNCTION zveltio_visible_tenants()
RETURNS uuid[]
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.visible_tenants', true), '') IS NOT NULL THEN
      string_to_array(current_setting('zveltio.visible_tenants', true), ',')::uuid[]
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      ARRAY[NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid]
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      ARRAY[]::uuid[]
    ELSE
      ARRAY['00000000-0000-0000-0000-000000000001'::uuid]
  END
$$;

CREATE OR REPLACE FUNCTION zveltio_visible_tenants_text()
RETURNS text[]
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.visible_tenants', true), '') IS NOT NULL THEN
      string_to_array(current_setting('zveltio.visible_tenants', true), ',')
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      ARRAY[NULLIF(current_setting('zveltio.current_tenant', true), '')]
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      ARRAY[]::text[]
    ELSE
      ARRAY['00000000-0000-0000-0000-000000000001']
  END
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_write_ok(row_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
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
  AND NULLIF(current_setting('zveltio.visible_tenants', true), '')
      IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_write_ok(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
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
  AND NULLIF(current_setting('zveltio.visible_tenants', true), '')
      IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'
$$;
