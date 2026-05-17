-- Drop the legacy zv_ddl_jobs table. pg-boss owns the queue since wave 32
-- (S5-04). Nothing writes to this table anymore; nothing reads from it
-- either (the routes/collections.ts code path was migrated in the same
-- wave).
--
-- Keeping the table around for ~6 months past the pg-boss cutover gave
-- operators time to query historical jobs. By the time this migration
-- runs on a deployment, those jobs are old enough to be irrelevant —
-- and pg-boss's own job-archive carries forward-looking history.

DROP TABLE IF EXISTS zv_ddl_jobs;

-- DOWN
-- Recreate the schema as it existed in migration 014_ddl_retry.sql.
-- We don't restore data — if a rollback is needed, run the pre-074
-- backup and lose only the jobs written since 074 applied (which is
-- always zero, since nothing writes to this table after wave 32).
CREATE TABLE IF NOT EXISTS zv_ddl_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error         TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  max_retries   INTEGER NOT NULL DEFAULT 3,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zv_ddl_jobs_status ON zv_ddl_jobs(status);
