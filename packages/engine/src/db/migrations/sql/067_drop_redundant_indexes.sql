-- 067_drop_redundant_indexes.sql
--
-- NO TRANSACTION
--
-- Indexes another index already answers, which every write still paid for:
--
--   idx_user_email            = "user"_email_key            (email)    UNIQUE
--   idx_session_token         = session_token_key           (token)    UNIQUE
--   idx_api_keys_hash         = zv_api_keys_key_hash_key    (key_hash) UNIQUE
--   idx_zv_tenants_slug       = zv_tenants_slug_key         (slug)     UNIQUE
--   idx_zv_roles_name         = zv_roles_name_key           (name)     UNIQUE
--   idx_zv_invitations_token  = zv_invitations_token_key    (token)    UNIQUE
--   idx_zv_revisions_tenant   (tenant_id) is the leading column of
--                             idx_zv_revisions_tenant_created (tenant_id, created_at DESC)
--
-- 064 matched indexes uniqueness included, so a plain index beside the UNIQUE
-- constraint's own was left. Checked with EXPLAIN on 20k revisions: a
-- `tenant_id = $1` predicate takes idx_zv_revisions_tenant_created, a token
-- lookup the constraint's index. CONCURRENTLY, so writes keep flowing.

DROP INDEX CONCURRENTLY IF EXISTS idx_user_email;
DROP INDEX CONCURRENTLY IF EXISTS idx_session_token;
DROP INDEX CONCURRENTLY IF EXISTS idx_api_keys_hash;
DROP INDEX CONCURRENTLY IF EXISTS idx_zv_tenants_slug;
DROP INDEX CONCURRENTLY IF EXISTS idx_zv_roles_name;
DROP INDEX CONCURRENTLY IF EXISTS idx_zv_invitations_token;
DROP INDEX CONCURRENTLY IF EXISTS idx_zv_revisions_tenant;

-- DOWN

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_email ON "user" (email);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_token ON session (token);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_keys_hash ON zv_api_keys (key_hash);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_tenants_slug ON zv_tenants (slug);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_roles_name ON zv_roles (name);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_invitations_token ON zv_invitations (token);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_revisions_tenant ON zv_revisions (tenant_id);
