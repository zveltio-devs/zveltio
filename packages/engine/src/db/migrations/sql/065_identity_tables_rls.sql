-- 065_identity_tables_rls.sql
--
-- `zv_api_keys`, `zv_invitations`, `zv_media_shares` and `zv_tenant_users`
-- carried `tenant_id` and no policy: one firm stayed out of another's keys,
-- invitations, share links and member list only because each route wrote
-- `where tenant_id = …`. A reader that does not — an RPC function, any SQL that
-- runs as `zveltio_rls` or an extension role — read every firm's rows. And three
-- of them defaulted `tenant_id` to the ROOT tenant when no tenant was set, so a
-- write that forgot its tenant made, among other things, a root-tenant API key:
-- the one kind that acts in every tenant.
--
-- 1. No root fallback. The default is the transaction's tenant or nothing, and
--    the column is NOT NULL: a row that names no tenant is refused, in every
--    install mode, superuser included. A NULL left by a write outside the
--    engine joins the default tenant (as 021, 031 and 063 decided); a share
--    first takes its file's or folder's tenant (031).
--
-- 2. FORCE RLS, read over the visible set and write to the own node — and
--    UPDATE and DELETE on the own node too: a FOR ALL policy lets DELETE through
--    on its USING alone, so a parent unit that READS its subtree could delete
--    its children's rows. Here each command has its own policy.
--
-- These four are what a tenant is resolved FROM — the key that names it, the
-- memberships a person picks one from, the invitation and the share link that
-- carry one — so the engine reads them before any tenant is set: on the pool,
-- as its own role, with no `zveltio.current_tenant`. That one context keeps
-- seeing every row (`zveltio_engine_outside_tenant`); any tenant transaction,
-- and every other role, sees its tenants only. Code inside a tenant
-- transaction that needs a person's memberships elsewhere, or a link's tenant
-- before it can enter it, asks the two SECURITY DEFINER functions below, which
-- answer exactly that and nothing more.
--
-- Not `tenant_isolation_*`: the boot reconciler rewrites every policy of that
-- name to one FOR ALL policy and puts the root fallback back on the column.
--
-- squawk's adding-not-nullable-field: SET NOT NULL scans under ACCESS EXCLUSIVE
-- — one row per key / share ever made, the wait bounded by the runner's
-- lock_timeout; its NOT VALID workaround buys nothing inside the runner's one
-- transaction (see 063).

-- squawk-ignore-file adding-not-nullable-field

-- Re-runnable.

CREATE OR REPLACE FUNCTION zveltio_engine_outside_tenant(tbl regclass) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
  SELECT NULLIF(current_setting('zveltio.current_tenant', true), '') IS NULL
     AND pg_catalog.pg_has_role(
           current_user,
           (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = tbl),
           'USAGE')
$$;

COMMENT ON FUNCTION zveltio_engine_outside_tenant(regclass) IS 'True for the role that owns `tbl` while no tenant is set: the engine resolving a tenant (API key, membership, invitation, share link) before it has one. See 065.';

-- Defaults, backfill, NOT NULL.

ALTER TABLE zv_api_keys ALTER COLUMN tenant_id
  SET DEFAULT NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid;
ALTER TABLE zv_invitations ALTER COLUMN tenant_id
  SET DEFAULT NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid;
ALTER TABLE zv_media_shares ALTER COLUMN tenant_id
  SET DEFAULT NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid;

DO $$
DECLARE
  t uuid;
  n int;
BEGIN
  -- Per tenant, as 031: a plain-role owner sees one tenant's media at a time.
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

  UPDATE zv_media_shares SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
   WHERE tenant_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE '065: % share(s) without a tenant now belong to the default tenant', n;
  END IF;
  UPDATE zv_api_keys SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
   WHERE tenant_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE '065: % API key(s) without a tenant now belong to the default tenant', n;
  END IF;
END $$;

ALTER TABLE zv_api_keys ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE zv_media_shares ALTER COLUMN tenant_id SET NOT NULL;

-- The policies.

DO $$
DECLARE
  t text;
  outside text;
  write_ok text := 'zveltio_tenant_write_ok(tenant_id)';
BEGIN
  FOREACH t IN ARRAY ARRAY['zv_api_keys', 'zv_invitations', 'zv_media_shares', 'zv_tenant_users'] LOOP
    outside := format('(SELECT zveltio_engine_outside_tenant(%L::regclass))', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING ('
      || 'tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]) OR %s%s)',
      t || '_tenant_select', t, outside,
      -- A root-tenant key acts in every tenant (validateApiKey), and reads its
      -- own record there (`GET /api/api-keys/self`): the presenting key, as
      -- publishApiKeyActor names it.
      CASE WHEN t = 'zv_api_keys' THEN
        ' OR (''apikey:'' || id::text) = (SELECT current_setting(''zveltio.user_id'', true))'
      ELSE '' END);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s OR %s)',
      t || '_tenant_insert', t, write_ok, outside);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s OR %s) WITH CHECK (%s OR %s)',
      t || '_tenant_update', t, write_ok, outside, write_ok, outside);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_delete', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s OR %s)',
      t || '_tenant_delete', t, write_ok, outside);
  END LOOP;
END $$;

-- The two reads a tenant transaction makes outside its tenant.

-- A person's memberships in every tenant: whether they are an administrator
-- elsewhere, still a member anywhere — the questions identity provisioning,
-- member removal and account deletion ask before they act on an account.
CREATE OR REPLACE FUNCTION zveltio_user_memberships(p_user text)
  RETURNS TABLE (tenant_id uuid, role text, valid_from timestamptz, valid_to timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET zveltio.current_tenant = ''
  AS $$
  SELECT tu.tenant_id, tu.role, tu.valid_from, tu.valid_to
    FROM public.zv_tenant_users tu
   WHERE tu.user_id = p_user
$$;

REVOKE ALL ON FUNCTION zveltio_user_memberships(text) FROM PUBLIC;
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION zveltio_user_memberships(text) TO zveltio_rls;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE '065: no zveltio_rls role, zveltio_user_memberships stays the owner''s';
END $$;

-- Deleting an account revokes its keys in every tenant: the request that deletes
-- it runs in one, and its UPDATE reached that tenant's keys alone.
CREATE OR REPLACE FUNCTION zveltio_revoke_user_api_keys(p_user text) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET zveltio.current_tenant = ''
  AS $$
  WITH revoked AS (
    UPDATE public.zv_api_keys SET is_active = false
     WHERE created_by = p_user AND is_active
    RETURNING 1
  )
  SELECT count(*)::int FROM revoked
$$;

REVOKE ALL ON FUNCTION zveltio_revoke_user_api_keys(text) FROM PUBLIC;
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION zveltio_revoke_user_api_keys(text) TO zveltio_rls;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE '065: no zveltio_rls role, zveltio_revoke_user_api_keys stays the owner''s';
END $$;

-- The tenant a share link belongs to, so the public `/share/:token` handler can
-- enter it: the link names no firm. The token is the credential, so whoever can
-- ask already holds the share. PUBLIC: it is an extension role that asks.
CREATE OR REPLACE FUNCTION zveltio_media_share_tenant(p_token text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET zveltio.current_tenant = ''
  AS $$
  SELECT s.tenant_id FROM public.zv_media_shares s WHERE s.token = p_token
$$;

-- DOWN

DROP FUNCTION IF EXISTS zveltio_media_share_tenant(text);
DROP FUNCTION IF EXISTS zveltio_revoke_user_api_keys(text);
DROP FUNCTION IF EXISTS zveltio_user_memberships(text);

DO $$
DECLARE
  t text;
  c text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zv_api_keys', 'zv_invitations', 'zv_media_shares', 'zv_tenant_users'] LOOP
    FOREACH c IN ARRAY ARRAY['select', 'insert', 'update', 'delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_' || c, t);
    END LOOP;
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

ALTER TABLE zv_api_keys ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE zv_media_shares ALTER COLUMN tenant_id DROP NOT NULL;

ALTER TABLE zv_api_keys ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
           '00000000-0000-0000-0000-000000000001'::uuid);
ALTER TABLE zv_invitations ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
           '00000000-0000-0000-0000-000000000001'::uuid);
ALTER TABLE zv_media_shares ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
           '00000000-0000-0000-0000-000000000001'::uuid);

DROP FUNCTION IF EXISTS zveltio_engine_outside_tenant(regclass);
