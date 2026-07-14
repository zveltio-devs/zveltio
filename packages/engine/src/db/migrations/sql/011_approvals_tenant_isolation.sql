-- Migration 011: tenant isolation for the approvals subsystem.
--
-- zv_approval_workflows / _requests / _steps / _decisions shipped as flat GLOBAL
-- tables (no tenant_id, no RLS). routes/approvals.ts queries them by id on the
-- raw pool db, so in a multi-tenant deployment any authenticated user could read
-- or act on another tenant's workflows / requests by id (cross-tenant IDOR).
-- Approvals is NOT admin-gated (regular users submit/list/view/decide), so this is
-- directly exposed.
--
-- Add tenant_id (NULLIF-guarded default like the RLS tables) + backfill. The
-- handlers additionally set tenant_id on every insert and filter every read/write
-- by the request's tenant id (explicit scoping — the approval routes run on the
-- raw db without a tenant GUC, so the DEFAULT is only a backstop; the handler sets
-- it explicitly).

ALTER TABLE zv_approval_workflows ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_approval_workflows SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_approval_workflows ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_approval_workflows_tenant ON zv_approval_workflows(tenant_id);

ALTER TABLE zv_approval_requests ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_approval_requests SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_approval_requests ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_approval_requests_tenant ON zv_approval_requests(tenant_id);

ALTER TABLE zv_approval_steps ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_approval_steps SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_approval_steps ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_approval_steps_tenant ON zv_approval_steps(tenant_id);

ALTER TABLE zv_approval_decisions ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_approval_decisions SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_approval_decisions ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_approval_decisions_tenant ON zv_approval_decisions(tenant_id);
