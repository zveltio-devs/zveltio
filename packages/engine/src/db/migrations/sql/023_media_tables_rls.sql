-- 023_media_tables_rls.sql
--
-- The four media tables go under the tenant policy every tenant table has.
--
-- `zv_media_files`, `zv_media_folders`, `zv_media_tags` and `zv_media_file_tags`
-- got `tenant_id` in 010/012 but no policy, "so background media jobs that run
-- without a tenant GUC are unaffected". The only such job, the trash purge, now
-- runs once per tenant inside `withTenantIsolation` (flow-scheduler.ts
-- `runPerTenant`), and every other reader and writer runs in the request
-- transaction. What was left was a boundary made only of the `where tenant_id`
-- each handler remembered to write: a whitelisted RPC function, or any handler
-- that forgets, saw every firm's media.
--
-- An install with `content/media` already has these policies — its migration
-- 002 creates them under the same names, and the boot reconciler rewrites them
-- to the shape below. This makes the engine's own tables safe without it.
--
-- The one reader with no tenant is a public share link: `/share/:token` is
-- answered before anything names a firm. `zv_media_shares` gets the `tenant_id`
-- of what it shares, so the handler can enter that tenant, and stays WITHOUT a
-- policy: the token lookup is what finds the tenant, and a policy on it would
-- need the tenant first.

-- ── zv_media_shares: record the firm of what is shared ────────────────
--
-- Nullable and added without a default, so the add is catalogue-only.
ALTER TABLE zv_media_shares ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Backfilled one tenant at a time with that tenant published, not in one join:
-- where `zv_media_files` is already under FORCE RLS (content/media installed)
-- and the migration runs as a plain owner role, a join with no tenant set sees
-- the default tenant's files only, and every other firm's links stay NULL.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM zv_tenants LOOP
    PERFORM set_config('zveltio.current_tenant', t::text, true);
    UPDATE zv_media_shares s SET tenant_id = f.tenant_id
      FROM zv_media_files f
     WHERE s.tenant_id IS NULL AND f.id = s.file_id AND f.tenant_id = t;
    UPDATE zv_media_shares s SET tenant_id = fo.tenant_id
      FROM zv_media_folders fo
     WHERE s.tenant_id IS NULL AND fo.id = s.folder_id AND fo.tenant_id = t;
  END LOOP;
  PERFORM set_config('zveltio.current_tenant', '', true);
END $$;

ALTER TABLE zv_media_shares ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
           '00000000-0000-0000-0000-000000000001'::uuid);

-- ── The four media tables ─────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'zv_media_files',
    'zv_media_folders',
    'zv_media_tags',
    'zv_media_file_tags'
  ] LOOP
    -- A NULL tenant_id is invisible to everyone under the policy. 010/012
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

-- The four policies stay when `content/media` is installed: its 002 policed
-- these tables under the same names before this migration, and dropping them
-- here would leave every firm's media readable by every other (as 024 keeps
-- `zv_import_logs` for `data/import`). Nothing re-polices them on boot: the
-- reconciler only visits tables that still carry a `tenant_isolation_*` policy.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM zv_migrations WHERE name = 'ext:content/media:002_tenant_rls') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'zv_media_files',
    'zv_media_folders',
    'zv_media_tags',
    'zv_media_file_tags'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_isolation_' || t, t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

ALTER TABLE zv_media_shares DROP COLUMN IF EXISTS tenant_id;
