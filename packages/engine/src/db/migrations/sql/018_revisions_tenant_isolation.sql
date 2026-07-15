-- Migration 018: tenant isolation for the audit trail (revisions + record comments).
--
-- zv_revisions stores a full JSONB snapshot of every record write, and
-- zv_record_comments holds per-record discussion — neither had tenant_id, and
-- every reader ran on the raw pool (or on a tenant transaction that does NOT
-- isolate a table with no tenant_id / no RLS). So:
--   - GET /api/revisions + GET /api/admin/revisions (admin, per-tenant) listed
--     every tenant's history, and time-travel `?as_of=` on the data list/single
--     handlers reconstructed records from another tenant's snapshots for ANY
--     user with collection read access (the "P0: use effectiveDb" comments there
--     were ineffective — effectiveDb can't isolate a table with no tenant_id);
--   - record comments were reachable by collection+record_id across tenants.
-- Add tenant_id (NULLIF-guarded default) + backfill; every reader now filters by
-- the request tenant and afterWrite/revert tag the row with the writing tenant.

ALTER TABLE zv_revisions ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_revisions SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_revisions ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_revisions_tenant ON zv_revisions(tenant_id);
-- The hot lookup is (collection, record_id) history for one tenant.
CREATE INDEX IF NOT EXISTS idx_zv_revisions_tenant_collection_record
  ON zv_revisions(tenant_id, collection, record_id, created_at DESC);

ALTER TABLE zv_record_comments ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_record_comments SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_record_comments ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_record_comments_tenant ON zv_record_comments(tenant_id);
