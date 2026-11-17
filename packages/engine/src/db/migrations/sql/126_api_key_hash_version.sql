-- 126_api_key_hash_version.sql
--
-- ADR 0058 decision 7 (DR-17): an API key's hash is an HMAC under the auth
-- secret, so making a new secret current answered 401 for every key. A key now
-- verifies under any secret the engine still holds — each `BETTER_AUTH_SECRETS`
-- entry, then `BETTER_AUTH_SECRET` — and the first use under a secret that is
-- not current rewrites the hash under the current one (lib/data/auth.ts).
--
-- This column records which secret wrote the hash: the `BETTER_AUTH_SECRETS`
-- version, or NULL for `BETTER_AUTH_SECRET`. Every existing row was written
-- under one or the other and is left NULL: the lookup does not trust the
-- column, and the next use corrects it. What it is for is the operator's count
-- before an old version leaves the list (docs/platform/security.md):
--   SELECT count(*) FROM zv_api_keys WHERE key_hash_version IS DISTINCT FROM <current>;

ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS key_hash_version INTEGER;
