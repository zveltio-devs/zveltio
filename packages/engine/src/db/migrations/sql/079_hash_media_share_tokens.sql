-- 079_hash_media_share_tokens.sql
--
-- Share-link tokens at rest become SHA-256 digests, as invitation tokens did in 038.
--
-- `zv_media_shares.token` is the bearer secret of a public `/share/:token` link,
-- and every role the request runs as reads the whole table: SQL on `zveltio_rls`
-- in a tenant (raw SQL, an extension's `ctx.db`, a flow, an insight) listed the
-- live links of every member of that tenant. Measured before this migration:
--
--     SET LOCAL ROLE zveltio_rls;
--     SELECT token FROM zv_media_shares;   → every link, usable as is
--
-- A column REVOKE (068's answer for preview tokens) would not do here: the
-- table's writer is an extension (storage/cloud), whose lookup filters on the
-- column, and a dump or backup would still carry every link. A digest is
-- unusable wherever it is read.
--
-- 1. The trigger owns the invariant whoever writes: a token that is not already
--    `sha256:<hex>` is hashed on INSERT and on UPDATE OF token, so a writer that
--    still sends the raw token stores its digest. Its link keeps working; a
--    lookup by the raw token in SQL no longer matches, so storage/cloud looks up
--    the digest of what it is given.
-- 2. `zveltio_media_share_tenant` hashes what it is given. Presenting the stored
--    digest as a token hashes it again and matches nothing.
-- 3. Existing rows are hashed in place, with no plaintext fallback (see 038).
--    The digest is unkeyed SHA-256 hex, so Postgres and Bun compute the same.

CREATE OR REPLACE FUNCTION zveltio_hash_media_share_token() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF NEW.token NOT LIKE 'sha256:%' THEN
    NEW.token := 'sha256:' || encode(sha256(convert_to(NEW.token, 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS zv_media_shares_hash_token ON zv_media_shares;
CREATE TRIGGER zv_media_shares_hash_token
  BEFORE INSERT OR UPDATE OF token ON zv_media_shares
  FOR EACH ROW EXECUTE FUNCTION zveltio_hash_media_share_token();

CREATE OR REPLACE FUNCTION zveltio_media_share_tenant(p_token text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET zveltio.current_tenant = ''
  AS $$
  SELECT s.tenant_id FROM public.zv_media_shares s
   WHERE s.token = 'sha256:' || encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

-- The trigger hashes the raw ones; a digest is left as it is.
UPDATE zv_media_shares SET token = token WHERE token NOT LIKE 'sha256:%';

COMMENT ON COLUMN zv_media_shares.token IS
  'sha256:<hex> of the share-link token (trigger zv_media_shares_hash_token); never the token itself';

-- DOWN

-- A digest cannot be turned back into its token: links issued before the
-- downgrade stop working on it, as with 038.
CREATE OR REPLACE FUNCTION zveltio_media_share_tenant(p_token text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET zveltio.current_tenant = ''
  AS $$
  SELECT s.tenant_id FROM public.zv_media_shares s WHERE s.token = p_token
$$;
DROP TRIGGER IF EXISTS zv_media_shares_hash_token ON zv_media_shares;
DROP FUNCTION IF EXISTS zveltio_hash_media_share_token();
COMMENT ON COLUMN zv_media_shares.token IS NULL;
