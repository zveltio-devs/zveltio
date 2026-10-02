-- 037_backup_schedule_id.sql
--
-- A schedule's retention_count was accepted by POST /api/backup/schedules,
-- editable and returned, and read by nothing: pruning was a global "keep the
-- newest 20" over every backup, because zv_backups could not say which
-- schedule wrote a row. This records it, so each schedule keeps its own count.
--
-- ON DELETE SET NULL: deleting a schedule does not delete the dumps it made;
-- they fall back under the global cap for backups no schedule owns.
--
-- Backfill from the filename, which every scheduled dump has carried since the
-- scheduler was written: backup-schedule-<uuid>-<timestamp>.sql.gz. A row whose
-- schedule is gone stays NULL.

-- The foreign key is NOT VALID: it is enforced for every row written from now
-- on, and adding it scans nothing. The rows already there are NULL or are set
-- below to an id that exists, so validating them would find nothing to refuse.

ALTER TABLE zv_backups ADD COLUMN IF NOT EXISTS schedule_id UUID;

-- Guarded: a rollback-and-reapply, or a rerun after a failure, must not die on
-- "constraint already exists" (ADD CONSTRAINT has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zv_backups_schedule_id_fkey'
  ) THEN
    ALTER TABLE zv_backups
      ADD CONSTRAINT zv_backups_schedule_id_fkey FOREIGN KEY (schedule_id)
      REFERENCES zv_backup_schedules(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

UPDATE zv_backups b
   SET schedule_id = s.id
  FROM zv_backup_schedules s
 WHERE b.schedule_id IS NULL
   AND b.filename LIKE 'backup-schedule-' || s.id::text || '-%';

-- DOWN

ALTER TABLE zv_backups DROP COLUMN IF EXISTS schedule_id;
