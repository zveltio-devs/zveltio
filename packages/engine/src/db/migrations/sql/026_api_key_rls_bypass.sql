-- Make the API-key RLS bypass an explicit, per-key decision.
--
-- `getRlsFilters` returned no filters at all for `authType === 'api_key'`, so
-- every key ignored every row-level policy. Unlike the god half of that same
-- condition — which was dead because `session.user.role` is undefined — this
-- half was live: an operator who wrote "users see only their own records" got
-- exactly that for people and no constraint at all for integrations, with
-- nothing in the UI saying so.
--
-- Defaults to TRUE, which is precisely today's behaviour. That is deliberate,
-- not timidity: RLS policies resolve their values from `user_id` / `user_email`
-- (see resolveValue), and a key's identity is the synthetic `apikey:<uuid>`,
-- which matches no real user. Enforcing such a policy against a key does not
-- make it safer — it makes it return ZERO rows, silently, and every integration
-- built on that key stops working without an error to point at. Empty results
-- are a worse failure than broad ones because nothing surfaces them.
--
-- What changes is that the bypass is now data: visible per key, revocable, and
-- meaningful to turn off for keys whose collections use `static:` or
-- `user_role` policies, which a machine credential CAN satisfy.
ALTER TABLE zv_api_keys
  ADD COLUMN IF NOT EXISTS rls_bypass BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN zv_api_keys.rls_bypass IS
  'When true (default) this key is not constrained by row-level security policies. Turn off for keys whose collections use identity-independent policies.';
