-- `zv_media_folders` has no `updated_at`, and two extensions select one.
--
-- The table is declared in `001_initial.sql` with `created_at` only. Both
-- `storage/cloud` and `content/media` read `updated_at` from it — the folder
-- listing orders by it — so on a fresh install `GET /ext/storage/cloud/files`
-- answers 500 with `column "updated_at" does not exist`, and Postgres helpfully
-- suggests `created_at` in the hint.
--
-- Found by pressing the route on a virgin database. It cannot be seen on a
-- long-lived instance: somebody added the column by hand at some point, which is
-- also why nobody noticed the migration never had it.
--
-- Added here rather than in an extension migration because the table is the
-- engine's own declaration. Backfilled from `created_at` so existing rows have a
-- sensible value rather than NULL — a folder that has never been renamed was
-- last changed when it was made.

ALTER TABLE zv_media_folders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE zv_media_folders SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE zv_media_folders ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE zv_media_folders ALTER COLUMN updated_at SET NOT NULL;
