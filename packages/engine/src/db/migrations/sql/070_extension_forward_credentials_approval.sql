-- 070_extension_forward_credentials_approval.sql
--
-- A worker extension's manifest `forwardCredentials` names the public routes on
-- which the engine hands its worker the caller's cookie, bearer token or API
-- key. That map was the extension's own claim: install only displayed it, and
-- the host forwarded whatever the manifest said, so a community extension (or
-- an upgrade of one) received credentials nobody had approved.
--
-- The operator's approval is now stored here, as the exact route -> headers map
-- they approved. The engine forwards a manifest's map only when every
-- (route, header) pair in it is in this record; anything wider forwards nothing
-- until approved again. NULL = never approved = nothing forwarded.
--
-- Re-runnable.

ALTER TABLE zv_extension_registry ADD COLUMN IF NOT EXISTS approved_forward_credentials jsonb;

COMMENT ON COLUMN zv_extension_registry.approved_forward_credentials IS
  'Manifest forwardCredentials an operator approved, as {route: [header, ...]}. The worker receives credential headers only when the manifest map is a subset of this one. NULL = none approved.';

-- DOWN
ALTER TABLE zv_extension_registry DROP COLUMN IF EXISTS approved_forward_credentials;
