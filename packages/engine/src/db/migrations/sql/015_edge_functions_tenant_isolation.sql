-- Migration 015: tenant isolation for edge functions.
--
-- zv_edge_functions / zv_edge_function_logs shipped as flat GLOBAL tables (no
-- tenant_id, no RLS). routes/edge-functions.ts lists them and reaches them by id on
-- the request db, and the public /api/fn/:name invoke path resolves the function by
-- name — all unscoped. So any tenant's admin could list/read/patch/delete/invoke
-- another tenant's functions (which store secrets in env_vars and run arbitrary
-- code) and read their invocation logs: cross-tenant IDOR. The handlers additionally
-- scope every read/write by the request's tenant and set tenant_id on every insert
-- (they run on the request db without relying on RLS).
--
-- The name UNIQUE constraint was GLOBAL, so two tenants couldn't share a function
-- name; swap it for UNIQUE(tenant_id, name).

-- ── zv_edge_functions ──────────────────────────────────────────────────────────
ALTER TABLE zv_edge_functions ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_edge_functions SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_edge_functions ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_edge_functions_tenant ON zv_edge_functions(tenant_id);

-- Global UNIQUE(name) → per-tenant UNIQUE(tenant_id, name).
ALTER TABLE zv_edge_functions DROP CONSTRAINT IF EXISTS zv_edge_functions_name_key;
ALTER TABLE zv_edge_functions ADD CONSTRAINT zv_edge_functions_tenant_name_key UNIQUE (tenant_id, name);

-- ── zv_edge_function_logs ──────────────────────────────────────────────────────
ALTER TABLE zv_edge_function_logs ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_edge_function_logs l SET tenant_id = f.tenant_id
  FROM zv_edge_functions f WHERE l.function_id = f.id AND l.tenant_id IS NULL;
UPDATE zv_edge_function_logs SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_edge_function_logs ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_edge_function_logs_tenant ON zv_edge_function_logs(tenant_id);
