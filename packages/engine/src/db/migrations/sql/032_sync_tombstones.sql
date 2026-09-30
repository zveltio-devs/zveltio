-- 032_sync_tombstones.sql
--
-- Sync pull learns which rows were deleted.
--
-- `/api/sync/pull` returns rows whose `updated_at` is past the client's
-- position, and a deleted row has nothing left to read: an offline client kept
-- every row deleted on the server, forever. Each delete from a collection table
-- now leaves a tombstone, returned as `operation: 'delete'` on the same
-- `(time, id)` keyset as the rows. Hard deletes stay hard deletes.
--
-- `deleted_at` is the deleting transaction's `now()` — its START, the clock
-- `updated_at` runs on. The pull delivers only what is older than the oldest
-- open transaction's start, so a long transaction's tombstones are held back
-- exactly like its rows, and cannot land behind a position already handed out.
--
-- Kept for `SYNC_TOMBSTONE_RETENTION_DAYS`; the nightly garbage collector
-- purges older ones, and a client whose position is older is told to resync.

CREATE TABLE IF NOT EXISTS zv_sync_tombstones (
  tenant_id  UUID NOT NULL,
  collection TEXT NOT NULL,
  row_id     UUID NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The pull's keyset, per tenant: `(deleted_at, row_id)` within one collection.
-- Leading with `tenant_id` also keeps the boot reconciler from building a
-- second tenant index beside it.
CREATE INDEX IF NOT EXISTS idx_zv_sync_tombstones_pull
  ON zv_sync_tombstones (tenant_id, collection, deleted_at, row_id);

ALTER TABLE zv_sync_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE zv_sync_tombstones FORCE ROW LEVEL SECURITY;

-- The shape the boot reconciler gives every `tenant_isolation_*` policy.
DROP POLICY IF EXISTS tenant_isolation_zv_sync_tombstones ON zv_sync_tombstones;
CREATE POLICY tenant_isolation_zv_sync_tombstones ON zv_sync_tombstones
  AS PERMISSIVE FOR ALL TO public
  USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))
  WITH CHECK (zveltio_tenant_write_ok(tenant_id));

-- One statement-level trigger per collection table (`DDLManager` attaches it).
--
-- SECURITY DEFINER because the deleter may hold no grant here: `zveltio_worker`
-- deletes collection rows and must not be able to forge a tombstone.
--
-- A delete may reach rows of another unit (a parent's or god's read reach), and
-- WITH CHECK admits only the writer's own unit. So each unit's tombstones are
-- written with that unit published as the writer; the function's own SET clause
-- restores the caller's value on exit.
CREATE OR REPLACE FUNCTION zveltio_sync_tombstone() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET zveltio.current_tenant = ''
AS $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM zv_old_rows LOOP
    PERFORM set_config('zveltio.current_tenant', t::text, true);
    INSERT INTO zv_sync_tombstones (tenant_id, collection, row_id)
      SELECT tenant_id, TG_TABLE_NAME, id FROM zv_old_rows WHERE tenant_id = t;
  END LOOP;
  RETURN NULL;
END $$;

-- Every existing collection table with the columns the trigger reads.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r'
       AND c.relname IN (SELECT 'zvd_' || name FROM zvd_collections)
       AND (SELECT count(*) FROM pg_attribute a
             WHERE a.attrelid = c.oid AND NOT a.attisdropped
               AND a.attname IN ('id', 'tenant_id') AND a.atttypid = 'uuid'::regtype) = 2
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER zv_sync_tombstone AFTER DELETE ON %I '
      || 'REFERENCING OLD TABLE AS zv_old_rows '
      || 'FOR EACH STATEMENT EXECUTE FUNCTION zveltio_sync_tombstone()', t);
  END LOOP;
END $$;

-- DOWN

-- CASCADE takes the trigger off every table it was attached to.
DROP FUNCTION IF EXISTS zveltio_sync_tombstone() CASCADE;
DROP TABLE IF EXISTS zv_sync_tombstones;
