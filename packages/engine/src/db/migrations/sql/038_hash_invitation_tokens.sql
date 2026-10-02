-- 038_hash_invitation_tokens.sql
--
-- Invitation tokens at rest become SHA-256 digests.
--
-- `zv_invitations.token` held the raw token from the invite link, and every
-- `user.invited` audit row carried it again as `resource_id`. One SELECT, or a
-- backup, was every live invitation: open the link, set a password, join the
-- tenant at the invited role. Reset and verification tokens were already
-- stored hashed. From this version POST /api/users/invite stores
-- `hashInvitationToken(token)` (lib/security/api-key-hash.ts) and the accept
-- routes look up the digest of what they are given.
--
-- Rows that already exist are hashed here rather than accepted in both forms
-- during a transition: the digest is unkeyed SHA-256 hex, so Postgres computes
-- exactly what the engine computes, and a pending link keeps working without a
-- plaintext fallback that would keep the old rows exploitable until they expire.
--
-- Stored as `sha256:<hex>`: the prefix tells a digest from a raw token (both
-- are 64 hex characters), so running this twice hashes nothing twice.

-- Audit rows first, while the raw token still identifies its invitation: point
-- them at the invitation id, which is what new rows record. A row whose
-- invitation was deleted keeps a value that no longer opens anything.
UPDATE zv_audit_log a
   SET resource_id = i.id::text
  FROM zv_invitations i
 WHERE a.event_type = 'user.invited'
   AND a.resource_type = 'invitation'
   AND a.resource_id = i.token;

UPDATE zv_invitations
   SET token = 'sha256:' || encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token NOT LIKE 'sha256:%';

COMMENT ON COLUMN zv_invitations.token IS
  'sha256:<hex> of the invitation token (lib/security hashInvitationToken); never the token itself';

-- DOWN

-- Deliberately a no-op: a digest cannot be turned back into its token. Links
-- issued before the upgrade stop working on a downgraded engine.
SELECT 1;
