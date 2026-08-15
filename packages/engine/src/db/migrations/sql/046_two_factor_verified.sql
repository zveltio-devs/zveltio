-- The column that made two-factor authentication impossible to switch on.
--
-- Found while fixing the backup-code storage, by trying to enable 2FA:
--
--   POST /api/auth/two-factor/enable → 500
--   PostgresError: column "verified" of relation "twoFactor" does not exist
--
-- Better-Auth writes `verified` when a user enables 2FA
-- (`plugins/two-factor/index.mjs:126`) and reads it when listing a user's
-- available methods (`:264`). `001_initial.sql` created the table with
-- `id, secret, backupCodes, userId` and nothing else, so the INSERT has always
-- failed. Two-factor authentication is on the feature list, is wired into the
-- auth plugin set, and could not be turned on by anybody.
--
-- Nothing caught it because the write comes from inside the auth library rather
-- than from a statement in this repository, so the seam gate — which reads the
-- SQL this codebase writes — had nothing to look at. The only way to find it was
-- to enable 2FA and watch.
--
-- Default TRUE, not FALSE. An existing row can only have been written by an
-- older Better-Auth that had no such column, which means it was created under a
-- version that treated the factor as usable once stored; reading those rows as
-- unverified would silently disable 2FA for anyone who has it today. New rows
-- get their value from the library on the way in.

ALTER TABLE "twoFactor" ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT TRUE;

-- And the two that implement lockout, which the same schema declares:
-- `failedVerificationCount` is incremented on every wrong code and `lockedUntil`
-- is set once it passes the limit (`verify-two-factor.mjs:138,160`). Without
-- them there is no rate limit on guessing a six-digit TOTP code at all, so
-- adding `verified` alone would have made 2FA switchable on and left it
-- brute-forceable. Found by enabling it again after the first column landed and
-- reading the next error.
ALTER TABLE "twoFactor" ADD COLUMN IF NOT EXISTS "failedVerificationCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "twoFactor" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMPTZ;

-- DOWN
ALTER TABLE "twoFactor" DROP COLUMN IF EXISTS verified;
ALTER TABLE "twoFactor" DROP COLUMN IF EXISTS "failedVerificationCount";
ALTER TABLE "twoFactor" DROP COLUMN IF EXISTS "lockedUntil";
