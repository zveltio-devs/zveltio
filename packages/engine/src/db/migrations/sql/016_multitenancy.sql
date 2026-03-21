-- Migration: 016_multitenancy
-- Multi-tenant SaaS mode: schema-per-tenant isolation + environments

-- Tenants registry (lives in public schema)
CREATE TABLE IF NOT EXISTS public.zv_tenants (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  plan             TEXT NOT NULL DEFAULT 'free'
                     CHECK (plan IN ('free', 'pro', 'enterprise', 'custom')),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'suspended', 'deleted')),
  max_records      INTEGER NOT NULL DEFAULT 10000,
  max_storage_gb   NUMERIC(10,2) NOT NULL DEFAULT 1.0,
  max_api_calls_day INTEGER NOT NULL DEFAULT 10000,
  max_users        INTEGER NOT NULL DEFAULT 5,
  billing_email    TEXT,
  trial_ends_at    TIMESTAMPTZ,
  settings         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_tenants_slug   ON public.zv_tenants(slug);
CREATE INDEX IF NOT EXISTS idx_zv_tenants_status ON public.zv_tenants(status);

-- Tenant ↔ user mapping
CREATE TABLE IF NOT EXISTS public.zv_tenant_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.zv_tenants(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by  TEXT REFERENCES public."user"(id) ON DELETE SET NULL,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON public.zv_tenant_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_user   ON public.zv_tenant_users(user_id);

-- Daily usage tracking per tenant
CREATE TABLE IF NOT EXISTS public.zv_tenant_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.zv_tenants(id) ON DELETE CASCADE,
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  api_calls     INTEGER NOT NULL DEFAULT 0,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  record_count  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tenant_id, date)
);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_tenant_date
  ON public.zv_tenant_usage(tenant_id, date DESC);

-- Environments per tenant (dev / staging / prod)
CREATE TABLE IF NOT EXISTS public.zv_environments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.zv_tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  schema_name   TEXT NOT NULL,
  is_production BOOLEAN NOT NULL DEFAULT false,
  color         TEXT DEFAULT '#6b7280',
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_environments_tenant
  ON public.zv_environments(tenant_id);

-- DOWN
DROP INDEX IF EXISTS idx_environments_tenant;
DROP TABLE IF EXISTS public.zv_environments;
DROP INDEX IF EXISTS idx_tenant_usage_tenant_date;
DROP TABLE IF EXISTS public.zv_tenant_usage;
DROP INDEX IF EXISTS idx_tenant_users_user;
DROP INDEX IF EXISTS idx_tenant_users_tenant;
DROP TABLE IF EXISTS public.zv_tenant_users;
DROP INDEX IF EXISTS idx_zv_tenants_status;
DROP INDEX IF EXISTS idx_zv_tenants_slug;
DROP TABLE IF EXISTS public.zv_tenants;
