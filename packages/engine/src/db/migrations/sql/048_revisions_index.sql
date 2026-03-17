-- Performance index for time-travel and audit queries on zv_revisions.
-- Uses CONCURRENTLY so the migration does not lock the table during creation.
-- Must run outside an explicit transaction block (Kysely executes each migration
-- in its own implicit transaction, but CONCURRENTLY is compatible with that).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_revisions_lookup
  ON zv_revisions (collection, record_id, created_at DESC);

-- DOWN
DROP INDEX CONCURRENTLY IF EXISTS idx_zv_revisions_lookup;
