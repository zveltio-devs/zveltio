-- Files stop being visible to the whole tenant by default.
--
-- `GET /api/media/files` required a session and nothing else: no permission
-- check, no owner filter. So every authenticated user could list and download
-- every file any colleague had ever uploaded. On a Business OS for companies
-- and public institutions that is not a rough edge — it is HR's scanned ID,
-- finance's payroll export, and legal's draft contract, readable by anyone with
-- a login.
--
-- The reason it was not obviously wrong is that `zv_media_files` serves two
-- purposes through one table. A CMS asset library WANTS tenant-wide reach: an
-- editor uploads the logo and everyone uses it. Personal storage does not.
-- Nothing in the schema said which a given row was, so the code could only pick
-- one answer for both, and it picked the permissive one.
--
--   tenant   — the shared library. Anyone in the tenant may read it.
--   personal — the uploader's own. Only they and a tenant admin may read it.
--
-- DEFAULT is `personal`: a file whose purpose nobody declared is the
-- uploader's. The media-library route sets `tenant` explicitly, as does the
-- storage route for a PUBLIC upload — those are served without authentication
-- anyway, so hiding them from a listing would be theatre.
--
-- Existing rows are backfilled to `tenant`. They were readable tenant-wide
-- yesterday, and an upgrade that silently hides files people were working with
-- is its own kind of broken. Operators narrow them deliberately.
--
-- Not addressed here, deliberately: sharing a personal file with a NAMED
-- colleague. `zv_media_shares` is link-based — token, password, expiry,
-- download cap — which covers "send this to someone" and not "give my teammate
-- access". That needs a per-file ACL and is a separate piece of work.

ALTER TABLE zv_media_files
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'personal';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zv_media_files_visibility_check'
  ) THEN
    ALTER TABLE zv_media_files
      ADD CONSTRAINT zv_media_files_visibility_check
      CHECK (visibility IN ('tenant', 'personal'));
  END IF;
END $$;

-- Backfill only what predates the column. Rows created after it exist already
-- carry the value their upload route chose, so this must not touch them —
-- hence the one-shot guard rather than a blanket UPDATE.
DO $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE zv_media_files
     SET visibility = 'tenant'
   WHERE visibility = 'personal'
     AND created_at < (
       SELECT COALESCE(MIN(applied_at), NOW())
       FROM zv_schema_versions
       WHERE version = 28
     );
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE WARNING
      'Media files are now personal by default. % pre-existing file(s) were kept '
      'tenant-visible so nothing that worked yesterday disappears. Narrow them in '
      'Studio, or: UPDATE zv_media_files SET visibility = ''personal'' WHERE id = ''<id>'';',
      affected;
  END IF;
END $$;

-- Listings filter on (tenant_id, visibility) and on (tenant_id, created_by).
CREATE INDEX IF NOT EXISTS idx_zv_media_files_visibility
  ON zv_media_files (tenant_id, visibility);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_owner
  ON zv_media_files (tenant_id, created_by);
