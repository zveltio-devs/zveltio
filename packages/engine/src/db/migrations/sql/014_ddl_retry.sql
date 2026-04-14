-- Bounded retry for DDL job queue.
-- retry_count is incremented on every failure; ddl-queue.ts re-queues
-- jobs whose retry_count < max_retries, so transient failures recover
-- automatically while permanent ones stay 'failed'.
ALTER TABLE zv_ddl_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zv_ddl_jobs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3;

-- DOWN
ALTER TABLE zv_ddl_jobs DROP COLUMN IF EXISTS max_retries;
ALTER TABLE zv_ddl_jobs DROP COLUMN IF EXISTS retry_count;
