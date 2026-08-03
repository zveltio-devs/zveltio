-- 032_api_key_rls_bypass_default_off.sql
--
-- A new API key is subject to row-level security unless someone says otherwise.
--
-- Migration 026 added `rls_bypass` with `DEFAULT true`, preserving what keys
-- did before the column existed. That was the right call for keys that already
-- existed and the wrong one for every key created since: creating a key the
-- ordinary way — a name and some scopes — produced a credential that row
-- policies did not apply to, and nothing in the request or the UI said so.
--
-- The default flips. Keys already in the table keep whatever value they were
-- created with, since a column DEFAULT does not touch existing rows: this
-- changes what happens NEXT, not what an operator already deployed.
--
-- The cost, stated plainly: a key against a collection with identity-based
-- policies (`user_id`, `owner`) now matches no rows, because a machine
-- credential has no identity for the policy to compare against. That key needs
-- `rls_bypass: true` explicitly — which is the case the flag was added for.

ALTER TABLE zv_api_keys
  ALTER COLUMN rls_bypass SET DEFAULT false;

COMMENT ON COLUMN zv_api_keys.rls_bypass IS
  'Exempt this key from row-level security. Defaults to FALSE (migration 032): '
  'set it explicitly for keys whose collections use identity-based policies, '
  'which a machine credential can never satisfy.';
