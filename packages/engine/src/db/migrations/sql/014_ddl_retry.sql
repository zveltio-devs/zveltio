-- Add retry_count to DDL job queue for transactional retry support
ALTER TABLE zv_ddl_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
