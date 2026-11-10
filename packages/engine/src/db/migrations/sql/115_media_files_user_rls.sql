-- 115_media_files_user_rls.sql
--
-- Who inside a firm may see a stored file, decided by the database too.
--
-- `zv_media_files` is policed for the tenant (023). Inside it, a `personal`
-- file is its uploader's, a `tenant` file everyone's, and a tenant admin sees
-- and deletes all of them — a rule that lived only in `lib/media-visibility.ts`,
-- so a statement that skipped the helper read and deleted every personal file
-- of the firm. `storage/cloud`'s drive listing is one: it lists the folder's
-- files with no owner filter at all.
--
-- These RESTRICTIVE policies are that rule, beside the tenant one:
--
--   read, update  sees all, or `visibility = 'tenant'`, or owns the file
--   delete        sees all, or owns the file (reading is not destroying)
--   insert        no actor, or the row is recorded as the caller's own upload
--
-- Owning is what `ownerColumn` says: a session owns `created_by = user`; a
-- member API key `created_by_api_key = <key>` (021) — not its issuer's files,
-- which the key never owned (`zveltio.user_id` is the key, ADR 0028 decision
-- 4). An extension job owns none: it is never its author to an engine table
-- (ADR 0028 decision 4; the owner refused ADR 0031 decision 2, 2026-11-10).
--
-- Sees all: `zveltio.files_all`, which the engine publishes from Casbin as the
-- storage route decides it — a session that is a tenant admin
-- (`isTenantAdmin`), a key with `rls_bypass` whose issuer is one — or no actor
-- (`zveltio.actor` not `on`): the engine's own work, which publishes no
-- identity, as the row rules stand down for it (the trash purge per tenant, a
-- public share link, tenant purge, boot). A worker extension's statement gets
-- the caller's files only (`workerSettings` carries no exemption).
--
-- The storage quota sums a user's bytes whoever asks, so it reads through
-- `zveltio_media_used_bytes`: a key counts its issuer's private files it may not
-- see, which its own view left out of the sum.
--
-- Not `tenant_isolation_*`: the boot reconciler rewrites every policy of that
-- name to one FOR ALL policy. Folders, tags and share links keep the tenant
-- policy alone: the application lists them tenant-wide.

-- Re-runnable.

CREATE OR REPLACE FUNCTION zveltio_media_sees_all() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  SELECT coalesce(current_setting('zveltio.actor', true), '') <> 'on'
      OR coalesce(current_setting('zveltio.files_all', true), '') = 'on'
$$;

-- The user id the caller owns files as: a session itself; NULL for a member
-- key, an extension job (`apikey:job:*`), an anonymous caller and no caller.
CREATE OR REPLACE FUNCTION zveltio_media_owner() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  SELECT CASE
           WHEN u LIKE 'apikey:%' THEN NULL
           ELSE NULLIF(u, '')
         END
    FROM (SELECT coalesce(current_setting('zveltio.user_id', true), '') AS u) s
$$;

-- The `zv_api_keys` row a member key owns files as (`apiKeyRowId`); NULL otherwise.
CREATE OR REPLACE FUNCTION zveltio_media_owner_key() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  SELECT CASE
           WHEN u ~* '^apikey:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN substr(u, 8)::uuid
         END
    FROM (SELECT coalesce(current_setting('zveltio.user_id', true), '') AS u) s
$$;

DROP POLICY IF EXISTS media_files_user_select ON zv_media_files;
CREATE POLICY media_files_user_select ON zv_media_files AS RESTRICTIVE FOR SELECT
  USING ((SELECT zveltio_media_sees_all())
         OR visibility = 'tenant'
         OR created_by = (SELECT zveltio_media_owner())
         OR created_by_api_key = (SELECT zveltio_media_owner_key()));

DROP POLICY IF EXISTS media_files_user_update ON zv_media_files;
CREATE POLICY media_files_user_update ON zv_media_files AS RESTRICTIVE FOR UPDATE
  USING ((SELECT zveltio_media_sees_all())
         OR visibility = 'tenant'
         OR created_by = (SELECT zveltio_media_owner())
         OR created_by_api_key = (SELECT zveltio_media_owner_key()))
  WITH CHECK ((SELECT zveltio_media_sees_all())
              OR visibility = 'tenant'
              OR created_by = (SELECT zveltio_media_owner())
              OR created_by_api_key = (SELECT zveltio_media_owner_key()));

DROP POLICY IF EXISTS media_files_user_delete ON zv_media_files;
CREATE POLICY media_files_user_delete ON zv_media_files AS RESTRICTIVE FOR DELETE
  USING ((SELECT zveltio_media_sees_all())
         OR created_by = (SELECT zveltio_media_owner())
         OR created_by_api_key = (SELECT zveltio_media_owner_key()));

-- An upload is recorded as its uploader's; a tenant admin uploads as themself.
DROP POLICY IF EXISTS media_files_user_insert ON zv_media_files;
CREATE POLICY media_files_user_insert ON zv_media_files AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT coalesce(current_setting('zveltio.actor', true), '') <> 'on')
              OR created_by = (SELECT zveltio_media_owner())
              OR created_by_api_key = (SELECT zveltio_media_owner_key()));

-- `p_user`'s live bytes in `p_tenant` (every visible tenant when NULL), read as
-- the engine's own work: the policies above stand down, the tenant one does not.
-- `set_config`, not a `SET` clause: a placeholder setting there needs a
-- superuser, and the documented owner role is none. An error aborts the
-- (sub)transaction, whose rollback puts the actor back.
CREATE OR REPLACE FUNCTION zveltio_media_used_bytes(p_tenant uuid, p_user text) RETURNS bigint
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  prev text := coalesce(current_setting('zveltio.actor', true), '');
  n bigint;
BEGIN
  PERFORM set_config('zveltio.actor', 'off', true);
  SELECT coalesce(sum(f.size), 0)::bigint INTO n
    FROM public.zv_media_files f
   WHERE f.created_by IS NOT DISTINCT FROM p_user
     AND f.deleted_at IS NULL
     AND (p_tenant IS NULL OR f.tenant_id = p_tenant);
  PERFORM set_config('zveltio.actor', prev, true);
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION zveltio_media_used_bytes(uuid, text) FROM PUBLIC;
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION zveltio_media_used_bytes(uuid, text) TO zveltio_rls;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE '115: no zveltio_rls role, zveltio_media_used_bytes stays the owner''s';
END $$;

-- DOWN

DROP FUNCTION IF EXISTS zveltio_media_used_bytes(uuid, text);
DROP POLICY IF EXISTS media_files_user_insert ON zv_media_files;
DROP POLICY IF EXISTS media_files_user_delete ON zv_media_files;
DROP POLICY IF EXISTS media_files_user_update ON zv_media_files;
DROP POLICY IF EXISTS media_files_user_select ON zv_media_files;
DROP FUNCTION IF EXISTS zveltio_media_owner_key();
DROP FUNCTION IF EXISTS zveltio_media_owner();
DROP FUNCTION IF EXISTS zveltio_media_sees_all();
