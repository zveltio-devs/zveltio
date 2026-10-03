-- 048_user_email_lower_unique.sql
--
-- One account per address, whatever its case: a unique index on lower(email).
--
-- `user_email_key` is case-sensitive, so `Ana@x.ro` and `ana@x.ro` could both
-- exist. better-auth lowercases what it writes but looks an address up exactly,
-- so a row stored in another case (an SSO/LDAP/SCIM insert with the IdP's
-- spelling, a row older than that lowercasing) was invisible to sign-up and to
-- invitation acceptance, which created a second account for the same mailbox —
-- and `provisionUser`, which matches by lower(email), then returned either one.
--
-- An install may already hold such twins, and building the index over them
-- fails. Stopping the upgrade there would take the instance down until someone
-- merged accounts by hand, so this skips the build instead and leaves it to the
-- engine to say so: a warning at every boot and `email_uniqueness` failing in
-- /api/health/deep, both naming the accounts. The runbook in
-- docs/platform/troubleshooting.md merges them and builds the index.
--
-- Why not CONCURRENTLY: CREATE INDEX CONCURRENTLY cannot run in a transaction
-- or a DO block, so it cannot be skipped on a condition — a `-- NO TRANSACTION`
-- file would have to fail on the twins. The plain build holds a SHARE lock on
-- "user" (reads go on, writes to "user" wait) for its duration: about 2.3 s per
-- million accounts, measured. The wait for the lock is bounded by the runner's
-- lock_timeout.
--
-- Re-runnable: inside the runner's transaction, and IF NOT EXISTS.

DO $$
DECLARE
  twins text;
BEGIN
  SELECT string_agg(format('%s: %s', e, ids), '; ') INTO twins
    FROM (SELECT lower(email) AS e, array_agg(id ORDER BY id) AS ids
            FROM "user" GROUP BY lower(email) HAVING count(*) > 1) d;
  IF twins IS NOT NULL THEN
    RAISE WARNING 'user_email_lower_key not built: accounts share an address in another case (%). Merge them, then build the index (docs/platform/troubleshooting.md).', twins;
    RETURN;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS user_email_lower_key ON "user" (lower(email));
END $$;

-- DOWN
DROP INDEX IF EXISTS user_email_lower_key;
