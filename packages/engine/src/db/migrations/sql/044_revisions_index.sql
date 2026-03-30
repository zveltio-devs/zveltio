-- Performance index for time-travel and audit queries on zv_revisions.
-- Note: CONCURRENTLY is not used here because migrations run inside a transaction block.

CREATE INDEX IF NOT EXISTS idx_zv_revisions_lookup
  ON zv_revisions (collection, record_id, created_at DESC);

-- DOWN
DROP INDEX IF EXISTS idx_zv_revisions_lookup;
