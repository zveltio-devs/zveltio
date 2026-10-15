-- 081_hash_preview_tokens.sql
--
-- Preview tokens at rest become SHA-256 digests, as invitation tokens did in 038
-- and share-link tokens in 079.
--
-- 068 took SELECT on `zv_schema_branches.preview_token` from `zveltio_rls`. A
-- column grant does not bind the table's owner, and in native RLS mode the
-- request runs as the owner, so SQL there still read every live token; so does
-- a dump or a backup. Measured before this migration, as the owner:
--
--     SELECT preview_token FROM zv_schema_branches;   → every token, usable as is
--
-- 1. The trigger owns the invariant whoever writes: a token that is not already
--    `sha256:<hex>` is hashed on INSERT and on UPDATE OF preview_token. The
--    routes keep writing the raw token and return it once, at enable and rotate.
-- 2. `zveltio_preview_branch` hashes what it is given. Presenting the stored
--    digest as a token hashes it again and matches nothing.
-- 3. Existing rows are hashed in place. Their raw tokens keep working, because
--    the lookup hashes what the client presents. The digest is unkeyed SHA-256
--    hex, so Postgres and Bun compute the same.
--
-- 068's column grant stays: the request role has no reason to read even a digest.

CREATE OR REPLACE FUNCTION zveltio_hash_preview_token() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NEW.preview_token NOT LIKE 'sha256:%' THEN
    NEW.preview_token := 'sha256:' || encode(sha256(convert_to(NEW.preview_token, 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS zv_schema_branches_hash_preview_token ON zv_schema_branches;
CREATE TRIGGER zv_schema_branches_hash_preview_token
  BEFORE INSERT OR UPDATE OF preview_token ON zv_schema_branches
  FOR EACH ROW EXECUTE FUNCTION zveltio_hash_preview_token();

CREATE OR REPLACE FUNCTION zveltio_preview_branch(p_token text)
  RETURNS TABLE (id uuid, preview_schema text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_digest text := 'sha256:' || encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
BEGIN
  UPDATE public.zv_schema_branches b
     SET preview_enabled = false, preview_token = NULL
   WHERE b.preview_token = v_digest AND b.preview_expires_at <= now();
  RETURN QUERY
    SELECT b.id, b.preview_schema FROM public.zv_schema_branches b
     WHERE b.preview_token = v_digest AND b.preview_enabled
       AND (b.preview_expires_at IS NULL OR b.preview_expires_at > now());
END
$$;

-- The trigger hashes the raw ones; a digest is left as it is.
UPDATE zv_schema_branches SET preview_token = preview_token
 WHERE preview_token NOT LIKE 'sha256:%';

COMMENT ON COLUMN zv_schema_branches.preview_token IS
  'sha256:<hex> of the preview token (trigger zv_schema_branches_hash_preview_token); never the token itself';

-- DOWN

-- A digest cannot be turned back into its token: preview links issued before the
-- downgrade stop working on it, as with 038 and 079.
CREATE OR REPLACE FUNCTION zveltio_preview_branch(p_token text)
  RETURNS TABLE (id uuid, preview_schema text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  UPDATE public.zv_schema_branches b
     SET preview_enabled = false, preview_token = NULL
   WHERE b.preview_token = p_token AND b.preview_expires_at <= now();
  RETURN QUERY
    SELECT b.id, b.preview_schema FROM public.zv_schema_branches b
     WHERE b.preview_token = p_token AND b.preview_enabled
       AND (b.preview_expires_at IS NULL OR b.preview_expires_at > now());
END
$$;
DROP TRIGGER IF EXISTS zv_schema_branches_hash_preview_token ON zv_schema_branches;
DROP FUNCTION IF EXISTS zveltio_hash_preview_token();
COMMENT ON COLUMN zv_schema_branches.preview_token IS NULL;
