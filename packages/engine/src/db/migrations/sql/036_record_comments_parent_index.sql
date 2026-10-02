-- 036_record_comments_parent_index.sql
--
-- NO TRANSACTION
--
-- zv_record_comments.parent_id is a self-referencing foreign key with
-- ON DELETE CASCADE and no index. Every comment delete makes Postgres run
-- `DELETE FROM ONLY zv_record_comments WHERE $1 = parent_id`, a sequential
-- scan, so deleting comments was quadratic in the size of the table: measured
-- on 195 000 rows, 5 000 deletes took 61.5 s without this index and 0.083 s
-- with it. Unlike the other unindexed foreign keys (they reference "user" and
-- are paid only when a user is deleted), this one fires on ordinary deletes.
--
-- CONCURRENTLY, so the build does not block comment writes; that is what the
-- NO TRANSACTION marker above is for. Drop first, as 030 does: a build that was
-- interrupted leaves an INVALID index that IF NOT EXISTS would keep.

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_record_comments_parent;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zv_record_comments_parent
  ON zv_record_comments (parent_id);

-- DOWN

DROP INDEX CONCURRENTLY IF EXISTS idx_zv_record_comments_parent;
