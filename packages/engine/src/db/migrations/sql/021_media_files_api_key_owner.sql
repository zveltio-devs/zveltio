-- 021_media_files_api_key_owner.sql
--
-- Which API key uploaded a stored file.
--
-- `/api/storage` admits a key holding `$storage`, and records its uploads as
-- the key's issuer (`created_by`, a foreign key into "user", which
-- `apikey:<uuid>` is not). The owner rule compares `created_by` with the
-- principal's id, so a key could upload a private file and then never list,
-- read or delete it again: the row belonged to a person, not to the key. This
-- column records the key itself; `created_by` keeps naming the issuer, who
-- still sees the file from their session.
--
-- SET NULL when the key row goes: the file stays, owned by its issuer alone.
-- No tenant column in the reference — the value is only ever the requesting
-- key's own id, set by the server, and every read also filters on the file's
-- `tenant_id`.
--
-- The reference is added NOT VALID then validated, as in 004; every existing
-- row is NULL, so the validating scan finds nothing. This file runs in the
-- runner's transaction on purpose: ADD COLUMN takes ACCESS EXCLUSIVE on
-- `zv_media_files`, and only the transactional path bounds that wait with
-- `lock_timeout` — under NO TRANSACTION it queued behind any open reader and
-- stalled every request that touches the table. The index is 022, built
-- CONCURRENTLY on its own, as 014 does for 013.

ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS created_by_api_key UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zv_media_files_created_by_api_key_fkey') THEN
    ALTER TABLE zv_media_files ADD CONSTRAINT zv_media_files_created_by_api_key_fkey
      FOREIGN KEY (created_by_api_key) REFERENCES zv_api_keys(id) ON DELETE SET NULL NOT VALID;
    ALTER TABLE zv_media_files VALIDATE CONSTRAINT zv_media_files_created_by_api_key_fkey;
  END IF;
END $$;

-- DOWN

ALTER TABLE zv_media_files DROP COLUMN IF EXISTS created_by_api_key;
