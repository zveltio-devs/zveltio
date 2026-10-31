-- 106_collection_written_by.sql
--
-- A collection an extension declares with `writtenBy: "actions"` is written
-- only by that extension's actions and jobs: every other create, update and
-- delete is refused. Set from the extension's collection file at its apply,
-- never by an operator. A flagged FIELD keeps the key in `fields` instead.

ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS written_by TEXT;

COMMENT ON COLUMN zvd_collections.written_by IS
  'Not NULL (the file says ''actions''): only the declaring extension''s actions and jobs write it.';

-- DOWN
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS written_by;
