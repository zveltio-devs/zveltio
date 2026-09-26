-- 020_user_sign_in_block.sql
--
-- A user who may not sign in at all, by any method.
--
-- SCIM deactivation (`active=false`) used to clear the credential password.
-- That stopped password sign-in only: a passkey, a magic link or an OAuth/SSO
-- account still signed the user in, and reactivation could not give the
-- password back. `banned = true` is checked where every session is created —
-- better-auth's `session.create.before` hook and the SSO session bridge — so it
-- covers every method, and clearing it restores access with the credentials
-- intact. Set through `lib/users.ts` `setUserActive`, which also revokes the
-- sessions that already exist.
--
-- `banned`, because better-auth's admin plugin uses that name for the same
-- idea; enabling that plugin later finds the column already there. Nullable,
-- so the add is a catalogue-only change: NULL and false both mean "may sign in".

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS banned BOOLEAN;

-- DOWN

ALTER TABLE "user" DROP COLUMN IF EXISTS banned;
