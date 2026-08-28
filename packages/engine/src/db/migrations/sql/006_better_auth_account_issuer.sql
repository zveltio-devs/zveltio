-- Better Auth 1.7 writes a column the schema does not have — and then looks for
-- it when signing you in.
--
-- Upgrading `better-auth` from 1.6.23 to 1.7.x turns every sign-up into a 500:
--
--   POST /api/auth/sign-up/email → 500
--   [Better Auth]: column "issuer" of relation "account" does not exist
--
-- 97 of 335 harness tests survived that; the other 238 failed at the same point,
-- because creating an account is the first thing a test does.
--
-- ── The half that adding the column does not fix ──────────────────────────
--
-- With the column added, sign-UP works and sign-IN still answers 401 with
-- "User not found" for an account that plainly exists. 1.7 stamps every
-- credential account it writes with `issuer = 'local:credential'` and matches on
-- it; a row carrying NULL is not found.
--
-- Every credential account written by 1.6 carries NULL. So on any existing
-- install, adding the column alone would let new users register and lock every
-- current one out — a silent, total lockout on an upgrade that looks routine.
--
-- Hence the backfill. It is narrowed to `providerId = 'credential'` on purpose:
-- an OAuth account's issuer is the identity provider that vouched for it, and
-- inventing `local:credential` there would be a lie about where that identity
-- came from.
--
-- An earlier draft of this file said "no backfill is owed: rows written before
-- 1.7 had no issuer to record". That was wrong, and it was wrong in the
-- direction that costs an operator their whole user base.

ALTER TABLE "account" ADD COLUMN IF NOT EXISTS issuer TEXT;

UPDATE "account"
   SET issuer = 'local:credential'
 WHERE issuer IS NULL
   AND "providerId" = 'credential';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM "account" WHERE "providerId" = 'credential' AND issuer IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      '% credential account(s) still carry a NULL issuer — they would not be able to sign in', n;
  END IF;
END $$;

COMMENT ON COLUMN "account".issuer IS
  'Who vouched for this identity. Better Auth 1.7 writes `local:credential` for '
  'password accounts and the provider''s issuer for OAuth ones, and matches on it '
  'at sign-in — a NULL here means the account cannot log in.';
