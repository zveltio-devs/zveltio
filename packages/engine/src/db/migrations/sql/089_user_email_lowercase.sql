-- 089_user_email_lowercase.sql
--
-- Every stored address in lower case, the spelling every path writes since:
-- better-auth lowercases what it writes, and so does `provisionUser`.
--
-- A row stored in another case — older than that lowercasing, or written by an
-- SSO/LDAP/SCIM login with the identity provider's spelling — signs in through
-- `storedEmail` (lib/auth-email.ts), but a row rule `owner_email eq user_email`
-- matched it only against rows written in that exact spelling. Row rules on
-- `user_email` now compare without case (rule-operators.ts), so lowercasing
-- costs the account none of the rows its old spelling granted.
--
-- Accounts that share an address in another case are left as they are: which
-- one is the real one is the operator's decision, and lowercasing both would
-- collide on `user_email_key`. 048 already skipped its index for them and the
-- engine names them at every boot and in /api/health/deep (`email_uniqueness`);
-- stopping the upgrade here would add an outage to a problem already reported.
-- The runbook in docs/platform/troubleshooting.md merges them.
--
-- Re-runnable: a lower-case address is not touched again.

DO $$
DECLARE
  twins text;
BEGIN
  UPDATE "user" SET email = lower(email)
   WHERE email <> lower(email)
     AND lower(email) IN (SELECT lower(email) FROM "user" GROUP BY 1 HAVING count(*) = 1);
  SELECT string_agg(format('%s: %s', e, ids), '; ') INTO twins
    FROM (SELECT lower(email) AS e, array_agg(id ORDER BY id) AS ids
            FROM "user" GROUP BY lower(email) HAVING count(*) > 1) d;
  IF twins IS NOT NULL THEN
    RAISE WARNING 'accounts that share an address in another case keep their spelling (%). Merge them (docs/platform/troubleshooting.md).', twins;
  END IF;
END $$;

-- DOWN
-- Nothing to undo: the original spelling is not kept, and the lower-case address
-- reaches the same account through every lookup and every row rule.
SELECT 1;
