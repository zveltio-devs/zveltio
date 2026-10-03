-- 043_environment_schema_optional.sql
--
-- An environment no longer has a Postgres schema of its own.
--
-- Every environment row used to come with a `tenant_<slug>_<env>` schema holding
-- empty copies of `zvd_collections`, `zvd_relations` and `zvd_permissions`.
-- Nothing ever read them: no request sets a search_path from an environment,
-- and the per-environment isolation that does exist is the preview schema
-- branches (`branch_*`). They looked like isolation they did not provide, and
-- `tenant_<a>_<x>` named both tenant `a`'s environment `x` and tenant `a-x`'s
-- schemas. The engine now creates environments with `schema_name` NULL.
--
-- Existing schemas are left alone: an operator may have put data in one, and
-- BYOD introspects any schema. Purging a tenant still drops the ones its rows
-- name, under the cross-tenant guard in `tenant-purge.ts`.
--
-- Re-runnable: dropping NOT NULL from a nullable column is a no-op. Lock: a
-- catalogue-only change, under ACCESS EXCLUSIVE for no longer than that.
--
-- squawk's ban-drop-not-null is for a client that reads the column as always
-- set. In the engine only purge reads it, and a NULL drops out of its
-- `LIKE 'tenant\_%'` filter; the API keeps answering `schema` (now `null`); no
-- extension reads the table (029). A replica of the previous release during a
-- rolling upgrade still writes a name, which purge handles as before. So the
-- drop is deliberate, and ignored for this file only.

-- squawk-ignore-file ban-drop-not-null

ALTER TABLE zv_environments ALTER COLUMN schema_name DROP NOT NULL;

-- DOWN

-- NOT NULL comes back only once every row has a value. A NULL row gets '' —
-- not the `tenant_<slug>_<env>` name the older engine would have made: that
-- name may belong to a schema this environment never had (another tenant's,
-- or an operator's), and the older purge drops what the column names. '' is
-- no schema name, so nothing is ever dropped for it. The table is under FORCE
-- RLS (029), so a plain owner role writes each tenant's rows as that tenant.
DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config(
    'zveltio.visible_tenants',
    coalesce((SELECT string_agg(id::text, ',') FROM zv_tenants), ''),
    true);
  FOR t IN SELECT DISTINCT tenant_id FROM zv_environments WHERE schema_name IS NULL LOOP
    PERFORM set_config('zveltio.current_tenant', t::text, true);
    UPDATE zv_environments SET schema_name = '' WHERE tenant_id = t AND schema_name IS NULL;
  END LOOP;
  PERFORM set_config('zveltio.current_tenant', '', true);
  PERFORM set_config('zveltio.visible_tenants', '', true);
END $$;

ALTER TABLE zv_environments ALTER COLUMN schema_name SET NOT NULL;
