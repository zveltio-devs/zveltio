-- 018_drop_tenant_plans_and_quota.sql
--
-- Tenant plans, limits and usage metering, removed. The engine is a BaaS; a
-- commercial layer on top of it belongs in an extension.
--
-- It came with the v1.0.0 squash: a `plan` enum and five `max_*`/billing
-- columns on `zv_tenants`, a `zv_tenant_usage` ledger, and a middleware that
-- answered 429 "Upgrade your plan" once a tenant passed `max_api_calls_day`.
-- Only that middleware ever read a limit, and nothing but the Studio tenant
-- form and one dashboard counter read the rest. `max_records`, `max_users`
-- and `max_storage_gb` were never enforced at all. With the middleware gone,
-- every one of these is a number that looks like a control and controls
-- nothing.
--
-- Tenancy itself — the row, slug, name, status, `settings`, the hierarchy and
-- every RLS policy — is untouched.
--
-- DROPPING WHILE AN OLDER ENGINE RUNS
--
-- squawk's ban-drop-column / ban-drop-table exist for the replica that is
-- still running the previous release during a rolling upgrade. Here that
-- replica loses: its quota lookup (which fails open), the plan fields on
-- `POST`/`PATCH /api/tenants` (an admin-only write, refused until it is
-- replaced) and the dashboard's API-call count. No tenant request is refused
-- and no data route reads these columns, so the window costs an administrator
-- a retry, and a two-release expand/contract would cost a release of dead
-- columns that still read as limits. Both statements are therefore
-- deliberate, and ignored for this file only.

-- squawk-ignore-file ban-drop-table, ban-drop-column

DROP TABLE IF EXISTS zv_tenant_usage;

ALTER TABLE zv_tenants
  DROP COLUMN IF EXISTS plan,
  DROP COLUMN IF EXISTS max_records,
  DROP COLUMN IF EXISTS max_storage_gb,
  DROP COLUMN IF EXISTS max_api_calls_day,
  DROP COLUMN IF EXISTS max_users,
  DROP COLUMN IF EXISTS billing_email,
  DROP COLUMN IF EXISTS trial_ends_at;

-- DOWN

-- The old shape and defaults, for an engine that still reads them. The values
-- they held are gone; every tenant comes back on the column defaults, and the
-- default tenant on 016's unlimited sentinel, because the quota middleware of
-- that engine reads the row and would otherwise refuse its request 10,001 of
-- the day again.
ALTER TABLE zv_tenants
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro', 'enterprise', 'custom')),
  ADD COLUMN IF NOT EXISTS max_records INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS max_storage_gb NUMERIC(10,2) NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS max_api_calls_day INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS max_users INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS billing_email TEXT,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

UPDATE zv_tenants SET
  plan = 'enterprise',
  max_api_calls_day = 2147483647,
  max_records = 2147483647,
  max_users = 2147483647,
  max_storage_gb = 999999
WHERE id = '00000000-0000-0000-0000-000000000001';

CREATE TABLE IF NOT EXISTS zv_tenant_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES zv_tenants(id) ON DELETE CASCADE,
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  api_calls     INTEGER NOT NULL DEFAULT 0,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  record_count  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, date)
);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_tenant_date
  ON zv_tenant_usage(tenant_id, date DESC);
