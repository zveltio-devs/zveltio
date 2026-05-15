-- Persist each migration's DOWN section so uninstall with purgeData=true can
-- run rollbacks in reverse order without needing the original migration files
-- on disk. The column is nullable: migrations applied before this change keep
-- NULL, meaning the extension cannot be cleanly purged without manual cleanup.

ALTER TABLE zv_migrations
  ADD COLUMN IF NOT EXISTS down_sql TEXT NULL;

-- DOWN
ALTER TABLE zv_migrations DROP COLUMN IF EXISTS down_sql;
