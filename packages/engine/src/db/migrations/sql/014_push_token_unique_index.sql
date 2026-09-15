-- 014_push_token_unique_index.sql
--
-- NO TRANSACTION
--
-- The constraint half of migration 013, separated so the index can be built
-- without locking the table.
--
-- `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (token)` builds the index under an
-- ACCESS EXCLUSIVE lock: reads AND writes to `zvd_push_tokens` block for the
-- whole build. On CI's empty table that is instant and invisible, which is
-- exactly the reason the migration-safety gate refuses it — the statement
-- behaves differently on a populated database, and push tokens are one row per
-- device per user, so a real install has as many as it has devices.
--
-- Built CONCURRENTLY instead, then adopted as the constraint. `USING INDEX`
-- takes the exclusive lock only to flip the catalog entry, not to scan.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction, which is what the
-- `NO TRANSACTION` marker above is for — the runner reads it (isNonTransactional)
-- and so does the gate, so execution and linting cannot disagree about what this
-- file is.
--
-- 013 has already removed the duplicate tokens, so the build cannot fail on
-- existing data. If it somehow does, CONCURRENTLY leaves an INVALID index
-- behind rather than a half-applied constraint; drop it and re-run.
--
-- Every statement here is re-runnable, which is the price of giving up the
-- transaction: a file that fails half way through gets run again, and none of
-- these three may object to the work the previous attempt finished.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS zvd_push_tokens_token_key
  ON zvd_push_tokens (token);

-- Guarded, because there is no transaction to roll back to: if this file fails
-- after the index is built, re-running it must not die on "constraint already
-- exists". `ADD CONSTRAINT` has no IF NOT EXISTS, so the check is explicit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'zvd_push_tokens'::regclass
       AND conname  = 'zvd_push_tokens_token_key'
  ) THEN
    ALTER TABLE zvd_push_tokens
      ADD CONSTRAINT zvd_push_tokens_token_key UNIQUE USING INDEX zvd_push_tokens_token_key;
  END IF;
END $$;

-- Now implied by the token constraint: keeping both would cost a second index
-- that can never refuse anything the first accepts.
ALTER TABLE zvd_push_tokens DROP CONSTRAINT IF EXISTS zvd_push_tokens_user_id_token_key;

-- DOWN
ALTER TABLE zvd_push_tokens DROP CONSTRAINT IF EXISTS zvd_push_tokens_token_key;
ALTER TABLE zvd_push_tokens ADD CONSTRAINT zvd_push_tokens_user_id_token_key UNIQUE (user_id, token);
