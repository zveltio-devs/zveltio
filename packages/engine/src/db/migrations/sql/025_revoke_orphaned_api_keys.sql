-- 025_revoke_orphaned_api_keys.sql
--
-- Revoke the API keys of users deleted before `deleteUser` revoked them.
--
-- `zv_api_keys.created_by` is ON DELETE SET NULL, and a key with no creator
-- kept authenticating: deleting a user (admin route, SCIM) left their keys
-- working, while deactivating the same user refused them. `deleteUser` now
-- revokes a user's keys before the row goes; this catches the ones already
-- orphaned. Every engine route that creates a key records its caller, so a
-- NULL creator can only mean a deleted one.
--
-- Revoked, not deleted: the access log cascades with the key row.

UPDATE zv_api_keys SET is_active = false WHERE created_by IS NULL AND is_active;

-- DOWN

-- Deliberately a no-op: which of these keys were active before is not
-- recorded, and re-activating every revoked orphan would also revive keys
-- revoked on purpose. Rolling back leaves them revoked.
SELECT 1;
