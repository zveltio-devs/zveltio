-- BASELINE SQUASH
--
-- Every engine migration collapsed into one file. The second such squash:
-- 001_initial.sql was itself 70 files (00d0bf85), and this folds the
-- 44 that followed into it.
--
-- Why now rather than at the 3.0.0 cut. The previous squash was safe because
-- "no deployment has shipped", which still holds at beta. What made it worth
-- doing is that the engine stopped creating seventeen tables belonging to
-- extensions, which took three migrations with it — so the chain carried a gap
-- at 011/020/036 and a modified 001 that every existing database would report
-- as a checksum mismatch on every boot. A fresh chain removes both.
--
-- Equivalence is not assumed: `pg_dump --schema-only` of a database built by
-- the old sequence and one built by this file were diffed and are identical.
--
-- It runs against exactly one kind of database: an empty one, on first boot.
-- The migration safety gate skips it for that reason and no other — see
-- scripts/check-migration-safety.ts. Statements added here still have to be
-- correct; they just cannot be judged by rules about populated databases.
--
-- zv_schema_versions is created first, so the bootstrap in applyMigration()
-- still works: its initial SELECT fails silently (no table yet), the UP creates
-- it, and the post-migration INSERT records the run.

-- ── from 001_initial.sql ───────────────────────────────────────────

-- 001_initial.sql
--
-- Consolidated initial schema for the Zveltio engine.
--
-- Squashed from 70 per-version migration files that accumulated
-- during alpha. The project is pre-1.0 and no Zveltio deployment
-- has shipped to production, so collapsing the history into one
-- file is safe — there is no installed base whose zv_schema_versions
-- table already records versions 000+. New deployments install the
-- full engine schema in a single migration; further schema changes
-- ship as 002_*.sql, 003_*.sql, ... going forward.
--
-- The CREATE TABLE for zv_schema_versions (originally 000) is the
-- first statement, so the migration runner can record its own
-- application of this file after the UP block completes — the bare
-- SELECT against zv_schema_versions in applyMigration() fails
-- silently on the first run because the table does not yet exist,
-- which is exactly the bootstrap path the loader is written for.
--
-- Source files (applied in this order):
--   • 000_schema_versions.sql
--   • 001_auth.sql
--   • 002_collections.sql
--   • 003_settings.sql
--   • 004_audit.sql
--   • 005_storage.sql
--   • 006_webhooks.sql
--   • 007_notifications.sql
--   • 008_api_keys.sql
--   • 009_translations.sql
--   • 010_import_logs.sql
--   • 012_record_comments.sql
--   • 013_extension_registry.sql
--   • 014_ddl_retry.sql
--   • 015_virtual_collections.sql
--   • 016_multitenancy.sql
--   • 017_flows.sql
--   • 018_media.sql
--   • 019_backups.sql
--   • 020_pages.sql
--   • 021_approvals.sql
--   • 022_drafts.sql
--   • 023_saved_queries.sql
--   • 024_validation_rules.sql
--   • 025_quality.sql
--   • 026_insights.sql
--   • 027_document_templates.sql
--   • 028_documents.sql
--   • 029_schema_branches.sql
--   • 030_rls_tenant_guc.sql
--   • 031_byod_is_managed.sql
--   • 035_pitr.sql
--   • 037_cloud_storage.sql
--   • 038_protected_api.sql
--   • 040_edge_functions.sql
--   • 041_revisions_index.sql
--   • 042_audit_log.sql
--   • 044_user_auth_v15.sql
--   • 046_slow_queries.sql
--   • 047_encrypted_fields.sql
--   • 048_roles.sql
--   • 049_client_portal.sql
--   • 050_zones_pages_views.sql
--   • 051_fix_client_zone_base_path.sql
--   • 052_role_cleanup.sql
--   • 053_strip_data_prefix.sql
--   • 054_rls_policies.sql
--   • 055_rpc_whitelist.sql
--   • 056_request_logs.sql
--   • 057_rate_limit_configs.sql
--   • 058_performance_indexes.sql
--   • 059_pg_trgm.sql
--   • 060_column_permissions.sql
--   • 061_push_tokens.sql
--   • 062_backup_schedules.sql
--   • 063_schema_branches_reviews.sql
--   • 064_schema_branches_preview_envs.sql
--   • 065_schema_branches_preview_token_expiry.sql
--   • 066_schema_branches_approval_gates.sql
--   • 067_insights.sql
--   • 068_insights_enterprise.sql
--   • 069_insights_reconcile.sql
--   • 070_extension_registry_tenant.sql
--   • 071_zv_migrations_down_sql.sql
--   • 072_extension_schedule_runs.sql
--   • 073_license_audit.sql
--   • 074_drop_legacy_ddl_jobs.sql
--   • 075_electric_replication.sql
--   • 076_erd_layout.sql
--   • 077_extension_rbac_defaults.sql

-- ── from 000_schema_versions.sql ──
-- Migration 000: Schema Version Tracking
-- Must be the first migration applied (000 prefix sorts before 001)

CREATE TABLE IF NOT EXISTS zv_schema_versions (
  id             SERIAL PRIMARY KEY,
  version        INTEGER NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  filename       TEXT NOT NULL,
  checksum       TEXT NOT NULL,
  applied_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  engine_version TEXT,
  execution_ms   INTEGER,
  rolled_back_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zv_schema_versions_version
  ON zv_schema_versions(version DESC);

-- Also create the legacy zv_migrations table for backward compatibility
CREATE TABLE IF NOT EXISTS zv_migrations (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert version 0 as baseline
INSERT INTO zv_schema_versions
  (version, name, filename, checksum, engine_version)
VALUES
  (0, 'baseline', '000_schema_versions.sql', 'baseline', '2.0.0')
ON CONFLICT (version) DO NOTHING;

-- ── from 001_auth.sql ──
-- Migration 001: Better-Auth tables + core user infrastructure

-- Better-Auth: User table
CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  image TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'manager', 'member')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Better-Auth: Session table
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  token TEXT UNIQUE NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

-- Better-Auth: Account table (OAuth & password)
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Better-Auth: Verification table
CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

-- Better-Auth: TwoFactor table
CREATE TABLE IF NOT EXISTS "twoFactor" (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  "backupCodes" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_userId ON session("userId");
CREATE INDEX IF NOT EXISTS idx_account_userId ON account("userId");
CREATE INDEX IF NOT EXISTS idx_user_email ON "user"(email);
CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);

-- ── from 002_collections.sql ──
-- Migration 002: Collections metadata, relations, permissions (Casbin)

-- Collections registry — tracks all user-defined collections
CREATE TABLE IF NOT EXISTS zvd_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  icon TEXT DEFAULT 'Table',
  route_group TEXT DEFAULT 'private'
    CHECK (route_group IN ('public', 'partners', 'private', 'admin')),
  is_permissioned BOOLEAN DEFAULT true,
  sort INTEGER DEFAULT 99,
  singular_name TEXT,
  description TEXT,
  fields JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Relations between collections
CREATE TABLE IF NOT EXISTS zvd_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('m2o', 'o2m', 'm2m', 'm2a')),
  source_collection TEXT NOT NULL,
  source_field TEXT NOT NULL,
  target_collection TEXT NOT NULL,
  target_field TEXT,
  junction_table TEXT,
  foreign_key_constraint TEXT,
  on_delete TEXT DEFAULT 'SET NULL'
    CHECK (on_delete IN ('CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION')),
  on_update TEXT DEFAULT 'CASCADE'
    CHECK (on_update IN ('CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_collection, source_field)
);

CREATE INDEX IF NOT EXISTS idx_zvd_relations_source ON zvd_relations(source_collection);
CREATE INDEX IF NOT EXISTS idx_zvd_relations_target ON zvd_relations(target_collection);

-- Casbin permissions policies
CREATE TABLE IF NOT EXISTS zvd_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ptype TEXT NOT NULL,
  v0 TEXT,
  v1 TEXT,
  v2 TEXT,
  v3 TEXT,
  v4 TEXT,
  v5 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_permissions_ptype ON zvd_permissions(ptype);
CREATE INDEX IF NOT EXISTS idx_zvd_permissions_v0 ON zvd_permissions(v0);

-- DDL job queue (async schema changes)
CREATE TABLE IF NOT EXISTS zv_ddl_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  error TEXT,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zv_ddl_jobs_status ON zv_ddl_jobs(status);

-- Default admin permissions
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'admin', '*', '*'),
  ('p', 'member', 'zvd_*', 'read'),
  ('g', 'admin', 'admin', NULL),
  ('g', 'manager', 'manager', NULL),
  ('g', 'member', 'member', NULL)
ON CONFLICT DO NOTHING;

-- ── from 003_settings.sql ──
-- Migration 003: Settings system

CREATE TABLE IF NOT EXISTS zv_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default settings
INSERT INTO zv_settings (key, value, description, is_public)
VALUES
  (
    'branding',
    '{"logo_url": null, "company_name": "Zveltio", "primary_color": "#069494", "secondary_color": "#006666", "dark_mode": false}',
    'Branding and theme settings',
    true
  ),
  (
    'smtp',
    '{"host": "", "port": 587, "secure": false, "user": "", "from_name": "Zveltio", "from_email": "noreply@zveltio.com"}',
    'SMTP configuration for email sending',
    false
  ),
  (
    'two_factor',
    '{"enabled": false, "required_for_admins": false, "required_for_all": false}',
    'Two-factor authentication settings',
    false
  ),
  (
    'api_docs_public',
    'false',
    'Whether API docs are publicly accessible',
    false
  ),
  (
    'site_url',
    '"http://localhost:3000"',
    'Public site URL for links and previews',
    true
  )
ON CONFLICT (key) DO NOTHING;

-- ── from 004_audit.sql ──
-- Migration 004: Audit trail (revisions)

-- Revisions system — tracks all changes to records
CREATE TABLE IF NOT EXISTS zv_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  data JSONB NOT NULL DEFAULT '{}',
  delta JSONB,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_revisions_record
  ON zv_revisions(collection, record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zv_revisions_user
  ON zv_revisions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zv_revisions_created
  ON zv_revisions(created_at DESC);

-- ── from 005_storage.sql ──
-- Migration 005: File storage (media library)

CREATE TABLE IF NOT EXISTS zv_media_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_id UUID REFERENCES zv_media_folders(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_media_folders_parent ON zv_media_folders(parent_id);

CREATE TABLE IF NOT EXISTS zv_media_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID REFERENCES zv_media_folders(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,  -- S3/SeaweedFS path
  url TEXT,                     -- Public URL if applicable
  width INTEGER,                -- For images
  height INTEGER,               -- For images
  metadata JSONB DEFAULT '{}',
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_media_files_folder ON zv_media_files(folder_id);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_mimetype ON zv_media_files(mimetype);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_created ON zv_media_files(created_at DESC);

-- ── from 006_webhooks.sql ──
-- Migration 006: Webhooks system

CREATE TABLE IF NOT EXISTS zvd_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT DEFAULT 'POST' CHECK (method IN ('POST', 'PUT', 'PATCH')),
  headers JSONB DEFAULT '{}',
  events TEXT[] NOT NULL,
  collections TEXT[],
  active BOOLEAN DEFAULT true,
  secret TEXT,
  retry_attempts INTEGER DEFAULT 3 CHECK (retry_attempts >= 0 AND retry_attempts <= 10),
  timeout INTEGER DEFAULT 5000 CHECK (timeout >= 1000 AND timeout <= 30000),
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zvd_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES zvd_webhooks(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL,
  headers JSONB DEFAULT '{}',
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  status INTEGER,
  response_body TEXT,
  error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_webhooks_active
  ON zvd_webhooks(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_zvd_webhook_deliveries_webhook
  ON zvd_webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_zvd_webhook_deliveries_created
  ON zvd_webhook_deliveries(created_at DESC);

-- ── from 007_notifications.sql ──
-- Migration 007: In-app notifications

CREATE TABLE IF NOT EXISTS zv_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info'
    CHECK (type IN ('info', 'success', 'warning', 'error')),
  action_url TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  source TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON zv_notifications(user_id, is_read, created_at DESC);

-- Web Push subscriptions
CREATE TABLE IF NOT EXISTS zv_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON zv_push_subscriptions(user_id);

-- ── from 008_api_keys.sql ──
-- Migration 008: API Keys for external access

CREATE TABLE IF NOT EXISTS zv_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,  -- SHA-256, never stored in plain
  key_prefix TEXT NOT NULL,       -- First 12 chars for identification (e.g. "zvk_a1b2c3")
  scopes JSONB NOT NULL DEFAULT '[]',
  -- scopes: [{"collection": "products", "actions": ["read"]}, {"collection": "*", "actions": ["read"]}]
  rate_limit INTEGER NOT NULL DEFAULT 1000,  -- requests per hour
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON zv_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON zv_api_keys(created_by);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON zv_api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON zv_api_keys(is_active) WHERE is_active = true;

-- ── from 010_import_logs.sql ──
-- Migration 010: Data import logs

CREATE TABLE IF NOT EXISTS zv_import_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_format TEXT NOT NULL DEFAULT 'csv'
    CHECK (file_format IN ('csv', 'xlsx', 'json', 'ndjson')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'partial')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  success_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  errors JSONB DEFAULT '[]',
  options JSONB DEFAULT '{}',   -- delimiter, skip_header, mapping, etc.
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zv_import_logs_collection ON zv_import_logs(collection);
CREATE INDEX IF NOT EXISTS idx_zv_import_logs_status ON zv_import_logs(status);
CREATE INDEX IF NOT EXISTS idx_zv_import_logs_created ON zv_import_logs(created_at DESC);

-- ── from 012_record_comments.sql ──
-- Migration 012: Record comments (threaded comments on any record)

CREATE TABLE IF NOT EXISTS zv_record_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  comment TEXT NOT NULL,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  parent_id UUID REFERENCES zv_record_comments(id) ON DELETE CASCADE,
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_record_comments_record
  ON zv_record_comments(collection, record_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_zv_record_comments_user
  ON zv_record_comments(user_id);

-- ── from 013_extension_registry.sql ──
CREATE TABLE IF NOT EXISTS zv_extension_registry (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text         UNIQUE NOT NULL,
  display_name text         NOT NULL,
  description  text,
  category     text         NOT NULL DEFAULT 'custom',
  version      text         NOT NULL DEFAULT '1.0.0',
  author       text,
  is_installed boolean      NOT NULL DEFAULT false,
  is_enabled   boolean      NOT NULL DEFAULT false,
  config       jsonb        NOT NULL DEFAULT '{}',
  installed_at timestamptz,
  enabled_at   timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);

-- ── from 014_ddl_retry.sql ──
-- Bounded retry for DDL job queue.
-- retry_count is incremented on every failure; ddl-queue.ts re-queues
-- jobs whose retry_count < max_retries, so transient failures recover
-- automatically while permanent ones stay 'failed'.
ALTER TABLE zv_ddl_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zv_ddl_jobs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3;

-- ── from 015_virtual_collections.sql ──
-- Virtual Collections: proxy to external APIs (Stripe, Shopify, ERP, etc.)
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'table'
  CHECK (source_type IN ('table', 'virtual'));
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS virtual_config jsonb;

COMMENT ON COLUMN zvd_collections.source_type IS 'table = PostgreSQL backed, virtual = external API proxy';
COMMENT ON COLUMN zvd_collections.virtual_config IS 'VirtualConfig JSON: source_url, auth_type, auth_value, field_mapping, list_path, id_field';

-- ── from 016_multitenancy.sql ──
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

-- ── from 017_flows.sql ──
-- Migration: 017_flows
-- Automation flows: triggers, steps, and run history

CREATE TABLE IF NOT EXISTS zv_flows (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  description    TEXT,
  trigger_type   TEXT NOT NULL DEFAULT 'manual'
                   CHECK (trigger_type IN ('manual', 'on_create', 'on_update', 'on_delete', 'cron', 'webhook')),
  trigger_config JSONB NOT NULL DEFAULT '{}',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  last_run_at    TIMESTAMPTZ,
  next_run_at    TIMESTAMPTZ,
  created_by     TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_flow_steps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id    UUID NOT NULL REFERENCES zv_flows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL DEFAULT 0,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL
               CHECK (type IN (
                 'run_script', 'send_email', 'webhook', 'query_db',
                 'condition', 'transform', 'delay',
                 'send_notification', 'export_collection'
               )),
  config     JSONB NOT NULL DEFAULT '{}',
  on_error   TEXT NOT NULL DEFAULT 'stop'
               CHECK (on_error IN ('stop', 'continue', 'retry')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_flow_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id      UUID NOT NULL REFERENCES zv_flows(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'success', 'failed', 'cancelled')),
  trigger_data JSONB,
  output       JSONB,
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zv_flows_active    ON zv_flows(is_active);
CREATE INDEX IF NOT EXISTS idx_zv_flow_steps_flow ON zv_flow_steps(flow_id, step_order);
CREATE INDEX IF NOT EXISTS idx_zv_flow_runs_flow  ON zv_flow_runs(flow_id, started_at DESC);

-- ── from 018_media.sql ──
-- Migration: 018_media
-- Extends media library (created in 005_storage) with tags, extra metadata columns

-- Add columns missing from the initial 005 schema
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS title          TEXT;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS description    TEXT;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS alt_text       TEXT;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS thumbnail_url  TEXT;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS duration_seconds INT;

-- Tags vocabulary
CREATE TABLE IF NOT EXISTS zv_media_tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- File ↔ tag join table (file_id must be UUID to match zv_media_files.id)
CREATE TABLE IF NOT EXISTS zv_media_file_tags (
  file_id UUID NOT NULL REFERENCES zv_media_files(id) ON DELETE CASCADE,
  tag_id  UUID NOT NULL REFERENCES zv_media_tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_zv_media_file_tags_file ON zv_media_file_tags(file_id);
CREATE INDEX IF NOT EXISTS idx_zv_media_file_tags_tag  ON zv_media_file_tags(tag_id);

-- ── from 019_backups.sql ──
-- Migration: 019_backups
-- Database backup metadata

CREATE TABLE IF NOT EXISTS zv_backups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     TEXT NOT NULL,
  size_bytes   BIGINT,
  status       TEXT NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress', 'completed', 'failed')),
  error        TEXT,
  notes        TEXT,
  created_by   TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_zv_backups_status     ON zv_backups(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zv_backups_created_at ON zv_backups(created_at DESC);

-- ── from 023_saved_queries.sql ──
-- Migration: 023_saved_queries
-- Saved visual query builder configurations

CREATE TABLE IF NOT EXISTS zv_saved_queries (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT    NOT NULL,
  description TEXT,
  collection  TEXT    NOT NULL,
  config      JSONB   NOT NULL DEFAULT '{}',
  is_shared   BOOLEAN NOT NULL DEFAULT false,
  created_by  TEXT    REFERENCES "user"(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_queries_user       ON zv_saved_queries(created_by);
CREATE INDEX IF NOT EXISTS idx_saved_queries_collection ON zv_saved_queries(collection);
CREATE INDEX IF NOT EXISTS idx_saved_queries_shared     ON zv_saved_queries(is_shared) WHERE is_shared = true;

-- ── from 024_validation_rules.sql ──
-- Migration: 024_validation_rules
-- Field-level validation rules with NL generation support

CREATE TABLE IF NOT EXISTS zv_validation_rules (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  collection     TEXT    NOT NULL,
  field_name     TEXT    NOT NULL,
  rule_type      TEXT    NOT NULL,
  nl_description TEXT,
  rule_config    JSONB   NOT NULL DEFAULT '{}',
  error_message  TEXT    NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_validation_rules_collection ON zv_validation_rules(collection, field_name);
CREATE INDEX IF NOT EXISTS idx_validation_rules_active     ON zv_validation_rules(collection) WHERE is_active = true;

-- ── from 025_quality.sql ──
-- Migration: 025_quality
-- AI Data Quality Engine

CREATE TABLE IF NOT EXISTS zv_quality_scans (
  id              UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  collection      TEXT  NOT NULL,
  scan_type       TEXT  NOT NULL DEFAULT 'full',
  status          TEXT  NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','completed','failed')),
  records_scanned INT   NOT NULL DEFAULT 0,
  issues_found    INT   NOT NULL DEFAULT 0,
  triggered_by    TEXT  REFERENCES "user"(id) ON DELETE SET NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS zv_quality_issues (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id     UUID    NOT NULL REFERENCES zv_quality_scans(id) ON DELETE CASCADE,
  collection  TEXT    NOT NULL,
  issue_type  TEXT    NOT NULL,
  severity    TEXT    NOT NULL DEFAULT 'warning'
              CHECK (severity IN ('info','warning','error')),
  record_ids  TEXT[]  NOT NULL DEFAULT '{}',
  field_name  TEXT,
  description TEXT    NOT NULL,
  suggestion  TEXT,
  auto_fixable BOOLEAN NOT NULL DEFAULT false,
  dismissed   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quality_scans_collection ON zv_quality_scans(collection, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_issues_scan      ON zv_quality_issues(scan_id);
CREATE INDEX IF NOT EXISTS idx_quality_issues_active    ON zv_quality_issues(collection) WHERE NOT dismissed;

-- ── from 026_insights.sql ──
-- Migration: 026_insights
-- Analytics dashboards and panels

CREATE TABLE IF NOT EXISTS zv_dashboards (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT    NOT NULL,
  description TEXT,
  icon        TEXT    NOT NULL DEFAULT 'BarChart',
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_by  TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_panels (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID  NOT NULL REFERENCES zv_dashboards(id) ON DELETE CASCADE,
  name         TEXT  NOT NULL,
  type         TEXT  NOT NULL DEFAULT 'table',
  query        TEXT  NOT NULL DEFAULT '',
  config       JSONB NOT NULL DEFAULT '{}',
  position_x   INT   NOT NULL DEFAULT 0,
  position_y   INT   NOT NULL DEFAULT 0,
  width        INT   NOT NULL DEFAULT 6,
  height       INT   NOT NULL DEFAULT 4,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_panels_dashboard ON zv_panels(dashboard_id, position_y, position_x);

-- ── from 028_documents.sql ──
-- Migration: 028_documents
-- RO compliance document templates + generated document records

CREATE TABLE IF NOT EXISTS zv_doc_templates (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT    NOT NULL,
  type              TEXT    NOT NULL,                         -- contract | pv | nir | etc.
  description       TEXT,
  template_html     TEXT    NOT NULL DEFAULT '',
  template_text     TEXT,
  variables         JSONB   NOT NULL DEFAULT '[]',            -- array of variable definitions
  source_collection TEXT,
  field_mapping     JSONB   NOT NULL DEFAULT '{}',            -- varName -> fieldName
  prefix            TEXT    NOT NULL DEFAULT '',
  counter           INT     NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_by        TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_templates_type ON zv_doc_templates(type, is_active);
-- ── from 029_schema_branches.sql ──
-- Migration 029: Schema Branches
-- Supports isolated schema branching for safe schema testing

CREATE TABLE IF NOT EXISTS zv_schema_branches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  base_schema  TEXT NOT NULL DEFAULT 'public',
  branch_schema TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'closed')),
  changes      JSONB NOT NULL DEFAULT '[]',
  created_by   TEXT,
  merged_by    TEXT,
  merged_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_schema)
);

CREATE INDEX IF NOT EXISTS idx_schema_branches_status ON zv_schema_branches(status);
CREATE INDEX IF NOT EXISTS idx_schema_branches_created ON zv_schema_branches(created_at DESC);

-- ── from 030_rls_tenant_guc.sql ──
-- Migration: 030_rls_tenant_guc
-- Configures the PostgreSQL GUC (Global User Configuration) parameter required for
-- Row-Level Security tenant isolation.
--
-- The middleware sets: SET LOCAL "zveltio.current_tenant" = '<tenant-uuid>'
-- RLS policies check: current_setting('zveltio.current_tenant', true)
--
-- Setting a database-level default ('') ensures new connections have an empty
-- tenant value rather than NULL/error, so RLS denies all rows by default
-- (empty string ≠ any valid UUID → secure by default).
--
-- The DO block gracefully degrades when the DB user is not a superuser.

DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET "zveltio.current_tenant" TO ''''',
    current_database()
  );
EXCEPTION WHEN others THEN
  RAISE NOTICE
    'zveltio: Could not set database-level GUC default for zveltio.current_tenant '
    '(superuser required). RLS will still work — current_setting() returns NULL safely. '
    'Error: %', SQLERRM;
END;
$$;

-- DOWN: manual rollback required
-- To revert: ALTER DATABASE <dbname> RESET "zveltio.current_tenant";

-- ── from 031_byod_is_managed.sql ──
-- 031_byod_is_managed.sql
-- Collection-level governance flags.
--
-- is_managed   — false = BYOD table, Zveltio will NOT run ALTER TABLE on it.
-- source_type  — 'table' = introspected from external DB; 'collection' = created by Zveltio.
-- is_system    — true for core collections shipped with the engine (contacts, orgs, etc).
-- schema_locked — true blocks removing columns (but ADD is still allowed).
--
-- is_system/schema_locked are required before ensureCoreCollections() (which runs
-- at boot) can INSERT core collection rows into zvd_collections.

ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS is_managed    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS source_type   TEXT    NOT NULL DEFAULT 'collection';
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS is_system     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS schema_locked BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN zvd_collections.is_managed    IS 'false = BYOD table, Zveltio will NOT alter schema';
COMMENT ON COLUMN zvd_collections.source_type   IS 'collection = created by Zveltio, table = introspected BYOD';
COMMENT ON COLUMN zvd_collections.is_system     IS 'true for engine-shipped core collections';
COMMENT ON COLUMN zvd_collections.schema_locked IS 'true blocks removing columns (ADD still allowed)';

-- ── from 035_pitr.sql ──
-- Migration: 035_pitr
-- PITR (Point-in-Time Recovery) configuration and restore points

CREATE TABLE IF NOT EXISTS zv_pitr_config (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_enabled          BOOLEAN NOT NULL DEFAULT false,
  wal_archive_path    TEXT,
  retention_days      INT NOT NULL DEFAULT 7,
  last_base_backup_at TIMESTAMPTZ,
  last_wal_segment    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO zv_pitr_config (id) VALUES (gen_random_uuid()) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS zv_pitr_restore_points (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  lsn         TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  TEXT REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pitr_restore_points_at ON zv_pitr_restore_points(recorded_at DESC);

-- ── from 037_cloud_storage.sql ──
-- 040_cloud_storage.sql
-- Zveltio Cloud: versioning, trash, sharing, favorites, quotas

-- === FILE VERSIONS ===
-- Each new upload to an existing file creates a version
CREATE TABLE IF NOT EXISTS zv_media_versions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       UUID        NOT NULL REFERENCES zv_media_files(id) ON DELETE CASCADE,
  version_num   INT         NOT NULL DEFAULT 1,
  storage_path  TEXT        NOT NULL,
  size_bytes    BIGINT      NOT NULL,
  mime_type     TEXT        NOT NULL,
  checksum      TEXT,
  uploaded_by   TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(file_id, version_num)
);

CREATE INDEX IF NOT EXISTS idx_media_versions_file ON zv_media_versions(file_id, version_num DESC);

-- === TRASH BIN ===
-- Soft delete: files go to trash, permanently deleted after 30 days
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS deleted_by TEXT REFERENCES "user"(id) ON DELETE SET NULL;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS restore_folder_id TEXT;

CREATE INDEX IF NOT EXISTS idx_media_files_deleted ON zv_media_files(deleted_at) WHERE deleted_at IS NOT NULL;

-- Soft delete on folders
ALTER TABLE zv_media_folders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- === PUBLIC SHARING ===
CREATE TABLE IF NOT EXISTS zv_media_shares (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       UUID        REFERENCES zv_media_files(id) ON DELETE CASCADE,
  folder_id     UUID        REFERENCES zv_media_folders(id) ON DELETE CASCADE,
  token         TEXT        NOT NULL UNIQUE,
  share_type    TEXT        NOT NULL DEFAULT 'view' CHECK (share_type IN ('view', 'download', 'edit')),
  password_hash TEXT,
  expires_at    TIMESTAMPTZ,
  max_downloads INT,
  download_count INT        NOT NULL DEFAULT 0,
  created_by    TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (file_id IS NOT NULL OR folder_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_media_shares_token ON zv_media_shares(token) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_media_shares_file ON zv_media_shares(file_id);
CREATE INDEX IF NOT EXISTS idx_media_shares_folder ON zv_media_shares(folder_id);

-- === STORAGE QUOTAS ===
CREATE TABLE IF NOT EXISTS zv_storage_quotas (
  user_id       TEXT        PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  quota_bytes   BIGINT      NOT NULL DEFAULT 5368709120,
  used_bytes    BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── from 038_protected_api.sql ──
-- 041_protected_api.sql
-- Enhanced API keys with IP whitelisting and Casbin integration

ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS allowed_ips TEXT[] DEFAULT NULL;
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS organization TEXT DEFAULT NULL;
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS description TEXT DEFAULT NULL;
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS permissions_mode TEXT NOT NULL DEFAULT 'scoped'
  CHECK (permissions_mode IN ('scoped', 'casbin', 'god'));
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS casbin_subject TEXT DEFAULT NULL;
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS request_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS last_ip TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS zv_api_key_access_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id  UUID        NOT NULL REFERENCES zv_api_keys(id) ON DELETE CASCADE,
  ip_address  TEXT        NOT NULL,
  method      TEXT        NOT NULL,
  path        TEXT        NOT NULL,
  status_code INT,
  duration_ms INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_key_access_log_key ON zv_api_key_access_log(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_key_access_log_created ON zv_api_key_access_log(created_at DESC);

-- ── from 040_edge_functions.sql ──
-- Edge function definitions
CREATE TABLE IF NOT EXISTS zv_edge_functions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,    -- URL-safe identifier
  display_name TEXT NOT NULL,
  description  TEXT,
  code         TEXT NOT NULL DEFAULT '', -- TypeScript/JS source
  runtime      TEXT NOT NULL DEFAULT 'bun',
  http_method  TEXT NOT NULL DEFAULT 'POST',  -- GET, POST, ANY
  path         TEXT NOT NULL,            -- /api/fn/<name> auto-assigned
  is_active    BOOLEAN NOT NULL DEFAULT true,
  timeout_ms   INTEGER NOT NULL DEFAULT 30000,
  env_vars     JSONB NOT NULL DEFAULT '{}',   -- {KEY: "value"} injected
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Invocation log
CREATE TABLE IF NOT EXISTS zv_edge_function_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id  UUID NOT NULL REFERENCES zv_edge_functions(id) ON DELETE CASCADE,
  status       INTEGER NOT NULL,         -- HTTP status
  duration_ms  INTEGER,
  request_body TEXT,
  response_body TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fn_logs_function ON zv_edge_function_logs(function_id, created_at DESC);

-- ── from 041_revisions_index.sql ──
-- Performance index for time-travel and audit queries on zv_revisions.
-- Note: CONCURRENTLY is not used here because migrations run inside a transaction block.

CREATE INDEX IF NOT EXISTS idx_zv_revisions_lookup
  ON zv_revisions (collection, record_id, created_at DESC);

-- ── from 042_audit_log.sql ──
-- 049: Centralized audit log for security events
CREATE TABLE IF NOT EXISTS zv_audit_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT        NOT NULL,
  user_id      TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  resource_id  TEXT,
  resource_type TEXT,
  metadata     JSONB       NOT NULL DEFAULT '{}',
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user    ON zv_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_type    ON zv_audit_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON zv_audit_log(created_at DESC);

-- Auto-cleanup: run periodically via cron/pg_cron
-- DELETE FROM zv_audit_log WHERE created_at < NOW() - INTERVAL '90 days';

-- ── from 044_user_auth_v15.sql ──
-- 051_user_auth_v15.sql
-- Compatibility fixes for better-auth v1.5:
--   1. Add twoFactorEnabled (twoFactor plugin adds this field to user SELECT queries)
--   2. Expand role CHECK constraint to include 'god'

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Drop the inline-generated CHECK constraint on role (name: user_role_check)
-- and recreate it to include 'god'.
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_role_check;
ALTER TABLE "user" ADD CONSTRAINT user_role_check
  CHECK (role IN ('god', 'admin', 'manager', 'member'));

-- ── from 046_slow_queries.sql ──
CREATE TABLE IF NOT EXISTS zv_slow_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query_params JSONB DEFAULT '{}',
  status_code INTEGER,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_slow_queries_duration ON zv_slow_queries(duration_ms DESC);
CREATE INDEX IF NOT EXISTS idx_slow_queries_path ON zv_slow_queries(path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slow_queries_created ON zv_slow_queries(created_at DESC);
-- Auto-purge old records (keep 7 days) — run via pg_cron or manual cleanup

-- ── from 047_encrypted_fields.sql ──
-- Per-field encryption support (no schema change required)
-- The encrypted flag is stored inside the fields JSONB column of zv_collections.
-- Encryption/decryption is handled entirely in the engine (field-crypto.ts).
-- Requires env var: FIELD_ENCRYPTION_KEY (openssl rand -hex 32)

-- Helper view: lists all encrypted fields across all collections
-- Created after zv_collections (migration 002) to avoid dependency issues.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'zv_collections') THEN
    EXECUTE '
      CREATE OR REPLACE VIEW zv_encrypted_fields AS
      SELECT
        c.name AS collection,
        f->>''name'' AS field_name,
        f->>''type'' AS field_type
      FROM zv_collections c,
        jsonb_array_elements(c.fields) AS f
      WHERE (f->>''encrypted'')::boolean = true
    ';
  END IF;
END $$;

-- ── from 048_roles.sql ──
-- Custom roles table for RBAC
-- Casbin uses role names (strings) as subjects in policies.
-- This table persists named roles so the Studio can manage them.

CREATE TABLE IF NOT EXISTS zv_roles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_roles_name ON zv_roles(name);

-- Seed built-in roles (employee is the baseline non-admin role)
INSERT INTO zv_roles (name, description)
VALUES
  ('employee', 'Employee role — grants access to the intranet portal'),
  ('manager',  'Manager role — inherits employee, can approve requests and view reports')
ON CONFLICT (name) DO NOTHING;

-- Casbin: employee can read intranet resources
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'employee', 'intranet', 'read'),
  ('p', 'employee', 'intranet', 'write'),
  ('p', 'manager',  'intranet', 'read'),
  ('p', 'manager',  'intranet', 'write'),
  -- manager inherits all employee permissions via Casbin role hierarchy
  ('g', 'manager', 'employee', NULL)
ON CONFLICT DO NOTHING;

-- ── from 049_client_portal.sql ──
-- Migration: 058_client_portal
-- Business-domain portal tables removed — replaced by the Zones/Pages/Views system (060).
-- Only role + permissions bootstrapping kept.

-- Add client role
INSERT INTO zv_roles (name, description)
VALUES ('client', 'Client portal user — access to the client portal zone')
ON CONFLICT (name) DO NOTHING;

-- Casbin: client role can access portal resources
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'client', 'portal', 'read'),
  ('p', 'client', 'portal', 'write')
ON CONFLICT DO NOTHING;

-- ── zones / pages / views: RETIRED, not moved ──────────────────────
--
-- `zvd_zones`, `zvd_pages`, `zvd_page_views` and `zvd_views` were the portal
-- architecture. `content/pages` replaced it and migrates OUT of these four
-- tables into the `zv_page*` family; nothing writes them any more.
--
-- So they are not handed to an extension, they are simply no longer created.
-- Recreating them in `content/pages` would resurrect a schema that extension
-- exists to retire. A database upgraded from an older engine keeps its rows and
-- its migration path — both remaining readers already treat absence as normal:
-- `content/pages/001_initial.sql` guards with `to_regclass(...) IS NULL`, and
-- `routes/admin/permission-routes.ts` treats SQLSTATE 42P01 as "no portals to
-- grant", which is the correct answer on every install made from here on.
--
-- Measured before removing: no code in either repo reads them. The three hits a
-- grep finds in `zveltio-extensions` are all comments. They also carried
-- `tenant_id` with no row-level security of any kind — so retiring them closes
-- that rather than carrying it forward.
-- ── from 052_role_cleanup.sql ──
-- Simplify user.role to only 'god' | 'member'.
-- All other roles (admin, manager, employee, client, etc.) are Casbin-only concepts.

-- Migrate any legacy 'admin' or 'manager' DB role values to 'member'
UPDATE "user" SET role = 'member' WHERE role IN ('admin', 'manager');

-- Rebuild the CHECK constraint
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_role_check;
ALTER TABLE "user" ADD CONSTRAINT user_role_check
  CHECK (role IN ('god', 'member'));

-- ── from 053_strip_data_prefix.sql ──
-- Strip the 'data:' prefix from Casbin collection policies.
-- Previously data-collection resources were stored as 'data:collection_name'.
-- They are now stored as 'collection_name' directly for consistency.
UPDATE zvd_permissions
SET v1 = SUBSTRING(v1 FROM 6)
WHERE ptype = 'p' AND v1 LIKE 'data:%';

-- ── from 054_rls_policies.sql ──
-- Row-Level Security policies (application-layer, Directus-style)
-- Each policy injects a WHERE clause into queries for a given collection + role.
-- Evaluated after Casbin (collection-level check passes first).

CREATE TABLE IF NOT EXISTS zvd_rls_policies (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection          TEXT        NOT NULL,   -- collection slug or '*' (all collections)
  role                TEXT        NOT NULL,   -- Casbin role name or '*' (all roles)
  filter_field        TEXT        NOT NULL,   -- field to filter on (e.g. 'created_by')
  filter_op           TEXT        NOT NULL DEFAULT 'eq', -- eq | neq | in | not_in
  filter_value_source TEXT        NOT NULL,
    -- 'user_id'     → current authenticated user's id
    -- 'user_email'  → current authenticated user's email
    -- 'user_role'   → current authenticated user's role
    -- 'static:VAL'  → literal value VAL (e.g. 'static:published')
  is_enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
  description         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rls_policies_lookup
  ON zvd_rls_policies (collection, role, is_enabled);

COMMENT ON TABLE zvd_rls_policies IS
  'Application-layer row-level security: policies injected as WHERE clauses at query time.';

-- ── from 055_rpc_whitelist.sql ──
-- RPC function whitelist — only explicitly registered PostgreSQL functions
-- can be called via POST /api/rpc/:function.

CREATE TABLE IF NOT EXISTS zvd_rpc_functions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name TEXT        NOT NULL UNIQUE,  -- exact PostgreSQL function name
  description   TEXT,
  required_role TEXT        NOT NULL DEFAULT 'member', -- minimum role to call
  is_enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpc_functions_lookup
  ON zvd_rpc_functions (function_name, is_enabled);

COMMENT ON TABLE zvd_rpc_functions IS
  'Whitelist of PostgreSQL functions exposed via POST /api/rpc/:function. '
  'Only functions explicitly registered here can be called by API clients.';

-- ── from 056_request_logs.sql ──
CREATE TABLE IF NOT EXISTS zv_request_logs (
  id          BIGSERIAL PRIMARY KEY,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  user_id     TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON zv_request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_path ON zv_request_logs(path);
CREATE INDEX IF NOT EXISTS idx_request_logs_status ON zv_request_logs(status);

-- ── from 057_rate_limit_configs.sql ──
-- Admin-configurable rate limit overrides per tier and per API key
CREATE TABLE IF NOT EXISTS zv_rate_limit_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_prefix  TEXT NOT NULL UNIQUE,  -- 'api', 'auth', 'ai', 'write', 'ddl', 'destructive', or 'apikey:<uuid>'
  window_ms   INTEGER NOT NULL DEFAULT 60000,
  max_requests INTEGER NOT NULL DEFAULT 200,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed defaults so the UI always shows values even before any admin changes
INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests, description) VALUES
  ('auth',        60000,  10,  'Authentication endpoints (sign-in, sign-up, forgot-password)'),
  ('api',         60000,  200, 'General API endpoints'),
  ('ai',          60000,  20,  'AI features (chat, search, embeddings)'),
  ('write',       60000,  60,  'Write operations (POST/PUT/PATCH/DELETE on data)'),
  ('ddl',         60000,  10,  'Schema changes (DDL operations)'),
  ('destructive', 60000,  10,  'Destructive operations (DELETE rows and collections)')
ON CONFLICT (key_prefix) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_rate_limit_configs_active ON zv_rate_limit_configs(key_prefix) WHERE is_active = true;

-- ── from 058_performance_indexes.sql ──
-- Performance indexes for common query patterns identified via EXPLAIN ANALYZE
-- Note: CONCURRENTLY is omitted — migration runner uses a transaction block.
-- On large production tables with existing data, create these manually if needed:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS <name> ON <table>(...);

-- Point queries on revisions by record (used in record detail views)
CREATE INDEX IF NOT EXISTS idx_revisions_record_id
  ON zv_revisions(record_id);

-- User activity timeline (audit log filtered by user + time desc)
CREATE INDEX IF NOT EXISTS idx_audit_log_user_time
  ON zv_audit_log(user_id, created_at DESC);

-- Active flow lookup by trigger type (used on every data write to find matching flows)
CREATE INDEX IF NOT EXISTS idx_flows_active_trigger
  ON zv_flows(is_active, trigger_type)
  WHERE is_active = true;

-- Casbin policy lookup by resource + action (v1=resource, v2=action, ptype='p')
CREATE INDEX IF NOT EXISTS idx_permissions_resource_action
  ON zvd_permissions(v1, v2)
  WHERE ptype = 'p';

-- API key lookup by owner + active status (used in key management UI)
CREATE INDEX IF NOT EXISTS idx_api_keys_created_by
  ON zv_api_keys(created_by, is_active);

-- Edge function logs time-range queries (log explorer per function)
CREATE INDEX IF NOT EXISTS idx_edge_fn_logs_time
  ON zv_edge_function_logs(created_at DESC);

-- Request logs by path + status (used in analytics / error dashboards)
CREATE INDEX IF NOT EXISTS idx_request_logs_path_status
  ON zv_request_logs(path, status, created_at DESC);

-- ── from 059_pg_trgm.sql ──
-- Enable pg_trgm extension for fuzzy/similarity search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Track which collections have trgm search support (search_text column + GIN trgm index)
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS has_trgm boolean NOT NULL DEFAULT false;

-- ── from 060_column_permissions.sql ──
-- Column-level access control — restricts read/write on individual fields per role
CREATE TABLE IF NOT EXISTS zvd_column_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_name text NOT NULL,
  column_name     text NOT NULL, -- use '*' for all columns
  role            text NOT NULL, -- role name; '*' matches all roles
  can_read        boolean NOT NULL DEFAULT true,
  can_write       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_name, column_name, role)
);

CREATE INDEX IF NOT EXISTS idx_col_perms_collection ON zvd_column_permissions (collection_name);

-- ── from 061_push_tokens.sql ──
-- Mobile push notification device tokens
CREATE TABLE IF NOT EXISTS zvd_push_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  token       text NOT NULL,
  platform    text NOT NULL CHECK (platform IN ('fcm', 'apns', 'web')),
  device_name text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON zvd_push_tokens (user_id);

-- ── from 062_backup_schedules.sql ──
-- Migration: 062_backup_schedules
-- Promotes the operations/backup extension into core. The base zv_backups table
-- already lives in 019_backups; here we add schedules + integrity tracking.

CREATE TABLE IF NOT EXISTS zv_backup_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL DEFAULT '0 2 * * *',
  retention_count INT NOT NULL DEFAULT 7,
  storage_destination TEXT NOT NULL DEFAULT 'local' CHECK (storage_destination IN ('local','s3','both')),
  s3_bucket TEXT,
  s3_prefix TEXT,
  notify_on_failure BOOLEAN NOT NULL DEFAULT true,
  notify_emails TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  next_run_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_backup_integrity_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes BIGINT,
  checksum_md5 TEXT,
  is_valid BOOLEAN,
  error TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_backup_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  s3_bucket TEXT,
  s3_key TEXT,
  size_bytes BIGINT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('in_progress','completed','failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_backup_schedules_active ON zv_backup_schedules(is_active, next_run_at);
CREATE INDEX IF NOT EXISTS idx_zv_backup_integrity_backup ON zv_backup_integrity_checks(backup_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_zv_backup_uploads_backup   ON zv_backup_uploads(backup_id, created_at DESC);

-- ── from 063_schema_branches_reviews.sql ──
-- Schema branch review requests
CREATE TABLE IF NOT EXISTS zvd_branch_review_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       UUID NOT NULL,
  requested_by    TEXT NOT NULL,
  reviewer_id     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','changes_requested','rejected')),
  message         TEXT,
  reviewer_note   TEXT,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE zv_schema_branches ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT NULL CHECK (review_status IN ('pending','approved','changes_requested','rejected'));
ALTER TABLE zv_schema_branches ADD COLUMN IF NOT EXISTS review_requested_by TEXT;
ALTER TABLE zv_schema_branches ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_branch_reviews ON zvd_branch_review_requests(branch_id, status);

-- ── from 064_schema_branches_preview_envs.sql ──
-- Preview environments: a branch can be "activated" as a live preview
-- with an isolated PostgreSQL schema reachable via X-Preview-Token header.
ALTER TABLE zv_schema_branches
  ADD COLUMN IF NOT EXISTS preview_enabled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS preview_token    TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS preview_schema   TEXT,
  ADD COLUMN IF NOT EXISTS preview_enabled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_branches_preview_token ON zv_schema_branches(preview_token)
  WHERE preview_token IS NOT NULL;

-- ── from 065_schema_branches_preview_token_expiry.sql ──
-- Preview environment token expiry and rotation support
ALTER TABLE zv_schema_branches
  ADD COLUMN IF NOT EXISTS preview_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preview_token_rotated_at TIMESTAMPTZ;

-- Default TTL: 7 days for existing active preview tokens
UPDATE zv_schema_branches
  SET preview_expires_at = preview_enabled_at + INTERVAL '7 days'
  WHERE preview_enabled = true AND preview_expires_at IS NULL AND preview_enabled_at IS NOT NULL;

-- Index for expiry cleanup job
CREATE INDEX IF NOT EXISTS idx_branches_preview_expires
  ON zv_schema_branches(preview_expires_at)
  WHERE preview_enabled = true;

-- ── from 066_schema_branches_approval_gates.sql ──
-- Approval gate flag per branch + global setting
ALTER TABLE zv_schema_branches
  ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT false;

-- Global setting: enforce approval on ALL branches by default
-- Stored in zv_settings key 'schema_branches.require_approval' (boolean, default false)

-- ── from 067_insights.sql ──
-- Analytics dashboards
CREATE TABLE IF NOT EXISTS zv_dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  layout JSONB NOT NULL DEFAULT '[]',
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dashboard panels (charts/metrics)
CREATE TABLE IF NOT EXISTS zv_panels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID NOT NULL REFERENCES zv_dashboards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'table' CHECK (type IN ('table','bar','line','pie','metric','area')),
  query TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  position JSONB NOT NULL DEFAULT '{}',
  refresh_interval INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_panels_dashboard ON zv_panels(dashboard_id);

-- ── from 068_insights_enterprise.sql ──
-- Dashboard sharing/collaboration
CREATE TABLE IF NOT EXISTS zvd_dashboard_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID NOT NULL REFERENCES zv_dashboards(id) ON DELETE CASCADE,
  shared_with_user_id TEXT,
  shared_with_role TEXT,
  permission TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view','edit')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dashboard_id, shared_with_user_id),
  UNIQUE (dashboard_id, shared_with_role)
);

-- Panel execution cache (TTL-based)
CREATE TABLE IF NOT EXISTS zvd_panel_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id UUID NOT NULL REFERENCES zv_panels(id) ON DELETE CASCADE UNIQUE,
  result JSONB NOT NULL DEFAULT '[]',
  row_count INT NOT NULL DEFAULT 0,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  execution_ms INT NOT NULL DEFAULT 0
);

-- Saved named queries library
CREATE TABLE IF NOT EXISTS zvd_insight_saved_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  query TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_public BOOLEAN NOT NULL DEFAULT false,
  use_count INT NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dashboard subscriptions (email reports)
CREATE TABLE IF NOT EXISTS zvd_dashboard_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID NOT NULL REFERENCES zv_dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily','weekly','monthly')),
  day_of_week INT,
  hour_of_day INT NOT NULL DEFAULT 8,
  last_sent_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dashboard_id, user_id)
);

-- Add to dashboards: tags, last_viewed_at
ALTER TABLE zv_dashboards ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE zv_dashboards ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ;
ALTER TABLE zv_dashboards ADD COLUMN IF NOT EXISTS view_count INT NOT NULL DEFAULT 0;

-- Add to panels: last_executed_at, avg_execution_ms
ALTER TABLE zv_panels ADD COLUMN IF NOT EXISTS last_executed_at TIMESTAMPTZ;
ALTER TABLE zv_panels ADD COLUMN IF NOT EXISTS avg_execution_ms INT;
ALTER TABLE zv_panels ADD COLUMN IF NOT EXISTS error_count INT NOT NULL DEFAULT 0;

CREATE INDEX idx_panel_cache_expires ON zvd_panel_cache(expires_at);
CREATE INDEX idx_saved_queries_tags ON zvd_insight_saved_queries USING gin(tags);

-- ── from 069_insights_reconcile.sql ──
-- Migration: 069_insights_reconcile
--
-- Some installs already had zv_dashboards/zv_panels created by the older
-- analytics/insights extension, with a slightly different schema (no
-- is_public, no tags, etc.). The CREATE TABLE IF NOT EXISTS in 067 was a
-- no-op for those installs and the new code paths fail with "column does
-- not exist".
--
-- ALTER TABLE … ADD COLUMN IF NOT EXISTS is idempotent — fresh installs that
-- already have the columns from migration 067 see this run as a no-op too.

ALTER TABLE zv_dashboards
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE zv_panels
  ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS position JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS refresh_interval INT,
  ADD COLUMN IF NOT EXISTS title TEXT;

-- 069 originally only reconciled dashboards. Routes use `title`, but the
-- 026 schema only had `name` (NOT NULL). Backfill title from name where
-- needed, then drop the NOT NULL on `name` so new INSERTs that only
-- provide title don't fail.
UPDATE zv_panels SET title = name WHERE title IS NULL;
ALTER TABLE zv_panels ALTER COLUMN name DROP NOT NULL;

-- ── from 070_extension_registry_tenant.sql ──
-- Extension registry: per-tenant activation support
-- tenant_id NULL  = global (available to all tenants / instance-wide)
-- tenant_id SET   = enabled only for that specific tenant

ALTER TABLE zv_extension_registry
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_zv_ext_registry_tenant
  ON zv_extension_registry(tenant_id);

-- Composite index for the common query pattern:
-- WHERE (tenant_id IS NULL OR tenant_id = $1) AND is_enabled = true
CREATE INDEX IF NOT EXISTS idx_zv_ext_registry_tenant_enabled
  ON zv_extension_registry(tenant_id, is_enabled);

-- ── from 071_zv_migrations_down_sql.sql ──
-- Persist each migration's DOWN section so uninstall with purgeData=true can
-- run rollbacks in reverse order without needing the original migration files
-- on disk. The column is nullable: migrations applied before this change keep
-- NULL, meaning the extension cannot be cleanly purged without manual cleanup.

ALTER TABLE zv_migrations
  ADD COLUMN IF NOT EXISTS down_sql TEXT NULL;

-- ── from 072_extension_schedule_runs.sql ──
-- Tracking table for native extension schedules (S2-05).
--
-- Each invocation of a schedule's handler — successful, failed, retried, or
-- pushed to DLQ — gets a row here. Admins can query for failures, replay DLQ
-- entries, and audit when extension jobs actually ran.

CREATE TABLE IF NOT EXISTS zv_extension_schedule_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_name  TEXT NOT NULL,
  schedule_name   TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL,            -- 'running' | 'ok' | 'failed' | 'dlq'
  attempt         INT NOT NULL DEFAULT 1,
  error_message   TEXT,
  trace_id        TEXT
);

CREATE INDEX IF NOT EXISTS idx_zv_ext_schedule_runs_ext_sched
  ON zv_extension_schedule_runs (extension_name, schedule_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_zv_ext_schedule_runs_status
  ON zv_extension_schedule_runs (status)
  WHERE status IN ('failed', 'dlq');

-- ── from 073_license_audit.sql ──
-- Audit log for marketplace license / token operations (S3-04).
--
-- Today the engine stores a single `marketplace_auth_token` in zv_settings.
-- If it ever leaks, an admin can call POST /api/admin/license/rotate to mint
-- a new one — every rotation lands here so leaks have a paper trail.
-- Per-extension license keys (zv_settings ext_license:<name>) flow through
-- the same audit when their lifecycle endpoints fire.

CREATE TABLE IF NOT EXISTS zv_license_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'rotate' | 'set' | 'delete'. Free-form for forward compatibility.
  action          TEXT NOT NULL,
  -- Which license this affects. NULL for the marketplace token itself.
  extension_name  TEXT,
  -- Who triggered it (user.id from session) — NULL only if invoked via CLI
  -- with a service-level token, which today is not implemented.
  performed_by    TEXT,
  performed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Source IP + UA for forensics. Both may be NULL behind reverse proxies
  -- if the engine isn't trusting X-Forwarded-For.
  ip              TEXT,
  user_agent      TEXT,
  -- Free-form JSON for action-specific context (e.g. old_token_fingerprint).
  -- Avoid storing the new token here in plaintext.
  details         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_zv_license_audit_performed_at
  ON zv_license_audit (performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_zv_license_audit_extension
  ON zv_license_audit (extension_name, performed_at DESC)
  WHERE extension_name IS NOT NULL;

-- ── from 074_drop_legacy_ddl_jobs.sql ──
-- Drop the legacy zv_ddl_jobs table. pg-boss owns the queue since wave 32
-- (S5-04). Nothing writes to this table anymore; nothing reads from it
-- either (the routes/collections.ts code path was migrated in the same
-- wave).
--
-- Keeping the table around for ~6 months past the pg-boss cutover gave
-- operators time to query historical jobs. By the time this migration
-- runs on a deployment, those jobs are old enough to be irrelevant —
-- and pg-boss's own job-archive carries forward-looking history.

DROP TABLE IF EXISTS zv_ddl_jobs;

-- ── from 075_electric_replication.sql ──
-- S5-07 — Electric SQL replication scaffolding.
--
-- Electric SQL streams Postgres changes to clients via a logical
-- replication slot. For a table to be eligible, it must:
--   1. Be added to a PUBLICATION (we use `zveltio_electric`).
--   2. Have `REPLICA IDENTITY FULL` so updates carry the full row image
--      (Electric needs the prior values for conflict resolution).
--
-- This migration creates the publication AND sets the default replica
-- identity policy. It does NOT add any tables to the publication; the
-- engine's `electric.ts` route does that lazily when a client requests
-- sync of a specific collection (so the publication only grows when
-- something actually needs it — replication slots have real cost).
--
-- Operators standing up Electric run this migration as part of their
-- normal `bun run migrate` flow; no manual SQL required.
--
-- ── Replication slot creation is INTENTIONALLY NOT here ────────────────
-- The slot is created by the Electric service itself on first connect.
-- Pre-creating it here would orphan it on engines that never deploy
-- Electric. Operators who choose CRDT instead pay zero overhead.

DO $$
BEGIN
  -- Create the publication if it doesn't exist. CREATE PUBLICATION
  -- IF NOT EXISTS isn't supported on older PG versions, so we use the
  -- DO block + pg_publication catalog lookup pattern.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'zveltio_electric') THEN
    CREATE PUBLICATION zveltio_electric;
  END IF;
END$$;

-- Helper function operators call to add a user collection to the
-- publication + set its replica identity. Safe to call repeatedly.
--
-- Usage (from the engine, after a client requests sync):
--   SELECT zv_electric_enable_table('zvd_contacts');
CREATE OR REPLACE FUNCTION zv_electric_enable_table(table_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  qualified TEXT;
BEGIN
  -- Guard against SQL injection — table names must match our naming
  -- convention (zvd_ prefix + safe identifier chars only).
  IF table_name !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid table name %', table_name;
  END IF;
  qualified := quote_ident(table_name);

  -- ALTER TABLE ... REPLICA IDENTITY FULL is idempotent — calling it
  -- a second time is a no-op.
  EXECUTE format('ALTER TABLE %s REPLICA IDENTITY FULL', qualified);

  -- Add to publication. ALTER PUBLICATION ... ADD TABLE throws on
  -- duplicate, so check first via pg_publication_tables.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'zveltio_electric' AND tablename = table_name
  ) THEN
    EXECUTE format('ALTER PUBLICATION zveltio_electric ADD TABLE %s', qualified);
  END IF;
END$$;

-- Inverse helper — removes a table from the publication. Called when
-- a collection is dropped (so the publication doesn't dangle).
CREATE OR REPLACE FUNCTION zv_electric_disable_table(table_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  qualified TEXT;
BEGIN
  IF table_name !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid table name %', table_name;
  END IF;
  qualified := quote_ident(table_name);
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'zveltio_electric' AND tablename = table_name
  ) THEN
    EXECUTE format('ALTER PUBLICATION zveltio_electric DROP TABLE %s', qualified);
  END IF;
END$$;

-- ── from 076_erd_layout.sql ──
-- Per-user ERD layouts for the schema-diagram view.
--
-- Each user can drag tables around to suit their mental model. The
-- previous (localStorage-only) implementation tied layouts to one browser,
-- which broke when users moved between work + home or shared sessions.
--
-- Design notes:
--   * `user_id` references the `user` table (better-auth). ON DELETE
--     CASCADE so a deleted user doesn't leave orphan rows.
--   * Float-not-numeric for x/y: ERDs don't need decimal precision and
--     float is cheaper. We round to int in the client anyway.
--   * No FK on `collection_name`: collections can be renamed, and the
--     application code already handles "layout points at gone collection"
--     by falling back to the auto-grid position. A FK would force us to
--     cascade-update on rename and cascade-delete on drop, neither of
--     which is the behavior we want here.

CREATE TABLE IF NOT EXISTS zv_erd_layouts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  collection_name TEXT NOT NULL,
  x               DOUBLE PRECISION NOT NULL,
  y               DOUBLE PRECISION NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, collection_name)
);

-- Used by GET /api/erd/layout to fetch every position for the current user.
CREATE INDEX IF NOT EXISTS idx_zv_erd_layouts_user
  ON zv_erd_layouts (user_id);

-- ── from 077_extension_rbac_defaults.sql ──
-- 077_extension_rbac_defaults.sql
--
-- Seeds Casbin policies so the per-extension `permissionGate` (SDK)
-- has sensible defaults when an operator turns it on.
--
-- Without these rows, every extension route gated by `permissionGate`
-- would 403 for non-god users — even basic read access. This migration
-- grants the built-in `employee` and `manager` roles minimal access
-- to the official extensions; operators tighten or relax via the
-- Studio Roles UI.
--
-- Convention: the gate's `resource` is the extension's logical name
-- (e.g. `'crm'`, `'invoices'`). Actions follow the standard CRUD
-- mapping (read / create / update / delete).
--
-- IMPORTANT — `g` row required: Casbin's matcher is
--   g(r.sub, p.sub) && (r.obj == p.obj || p.obj == '*') && (r.act == p.act || p.act == '*')
-- so a user must be mapped to the 'employee' or 'manager' role via a
-- `g` row before the `p` rows below take effect, e.g.
--   INSERT INTO zvd_permissions (ptype, v0, v1, v2)
--   VALUES ('g', '<user-id>', 'employee', NULL);
-- The Studio Roles UI exposes that mapping; no users are mapped by
-- default.

-- Casbin policy rows are conceptually unique on (ptype, v0, v1, v2)
-- (and v3..v5 for the rare extended-policy types). Without an explicit
-- unique index, ON CONFLICT below would have nothing to arbitrate on
-- and re-running this migration would duplicate every policy row,
-- bloating the in-memory enforcer and the policy cache. Add the index
-- as part of this migration so the ON CONFLICT clauses actually
-- deduplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_zvd_permissions_policy_unique
  ON zvd_permissions (ptype, COALESCE(v0, ''), COALESCE(v1, ''), COALESCE(v2, ''));

-- Read-only baseline for `employee` on day-to-day operational extensions.
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'employee', 'crm',                  'read'),
  ('p', 'employee', 'invoices',             'read'),
  ('p', 'employee', 'quotes',               'read'),
  ('p', 'employee', 'expenses',             'read'),
  ('p', 'employee', 'expenses',             'create'),
  ('p', 'employee', 'inventory',            'read'),
  ('p', 'employee', 'helpdesk',             'read'),
  ('p', 'employee', 'helpdesk',             'create'),
  ('p', 'employee', 'projects',             'read'),
  ('p', 'employee', 'documents',            'read'),
  ('p', 'employee', 'document-templates',   'read'),
  ('p', 'employee', 'media',                'read'),
  ('p', 'employee', 'forms',                'read'),
  ('p', 'employee', 'search',               'read'),
  ('p', 'employee', 'translations',         'read'),
  ('p', 'employee', 'checklists',           'read'),
  -- leave/time-tracking are SHARED tables; the gate is method+resource
  -- (not row-level), so granting an employee 'update' here would let
  -- them modify ANY user's leave request. Stay on read+create only —
  -- the extension handlers must use `entityAccess.register()` if they
  -- want to let an employee edit their own submission.
  ('p', 'employee', 'leave',                'create'),
  ('p', 'employee', 'leave',                'read'),
  ('p', 'employee', 'time-tracking',        'read'),
  ('p', 'employee', 'time-tracking',        'create'),
  ('p', 'employee', 'assets',               'read'),
  ('p', 'employee', 'pos',                  'read')
ON CONFLICT (ptype, COALESCE(v0, ''), COALESCE(v1, ''), COALESCE(v2, '')) DO NOTHING;

-- Manager: write access on most operational extensions; HR/finance stay
-- read-only here (operators add the specifics via Studio).
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES
  ('p', 'manager', 'crm',                  'read'),
  ('p', 'manager', 'crm',                  'create'),
  ('p', 'manager', 'crm',                  'update'),
  ('p', 'manager', 'invoices',             'read'),
  ('p', 'manager', 'invoices',             'create'),
  ('p', 'manager', 'invoices',             'update'),
  ('p', 'manager', 'quotes',               'read'),
  ('p', 'manager', 'quotes',               'create'),
  ('p', 'manager', 'quotes',               'update'),
  ('p', 'manager', 'expenses',             'read'),
  ('p', 'manager', 'expenses',             'create'),
  ('p', 'manager', 'expenses',             'update'),
  ('p', 'manager', 'inventory',            'read'),
  ('p', 'manager', 'inventory',            'create'),
  ('p', 'manager', 'inventory',            'update'),
  ('p', 'manager', 'helpdesk',             'read'),
  ('p', 'manager', 'helpdesk',             'create'),
  ('p', 'manager', 'helpdesk',             'update'),
  ('p', 'manager', 'projects',             'read'),
  ('p', 'manager', 'projects',             'create'),
  ('p', 'manager', 'projects',             'update'),
  ('p', 'manager', 'documents',            'read'),
  ('p', 'manager', 'documents',            'create'),
  ('p', 'manager', 'document-templates',   'read'),
  ('p', 'manager', 'media',                'read'),
  ('p', 'manager', 'media',                'create'),
  ('p', 'manager', 'media',                'update'),
  ('p', 'manager', 'forms',                'read'),
  ('p', 'manager', 'search',               'read'),
  ('p', 'manager', 'translations',         'read'),
  ('p', 'manager', 'checklists',           'read'),
  ('p', 'manager', 'checklists',           'create'),
  ('p', 'manager', 'checklists',           'update'),
  ('p', 'manager', 'approvals',            'read'),
  ('p', 'manager', 'approvals',            'update'),
  ('p', 'manager', 'leave',                'read'),
  ('p', 'manager', 'leave',                'update'),
  ('p', 'manager', 'time-tracking',        'read'),
  ('p', 'manager', 'assets',               'read'),
  ('p', 'manager', 'assets',               'update'),
  ('p', 'manager', 'pos',                  'read'),
  ('p', 'manager', 'pos',                  'create'),
  ('p', 'manager', 'pos',                  'update')
ON CONFLICT (ptype, COALESCE(v0, ''), COALESCE(v1, ''), COALESCE(v2, '')) DO NOTHING;


-- ── Extension-owned tables are NOT created here ─────────────────────────────
--
-- Seventeen tables were removed from this file: the approvals set, the drafts
-- set, document templates and generations, form submissions, generated docs,
-- media favourites, pages and page sections, the translations set. Each one
-- belongs to an extension that creates it itself, and none is read by engine
-- code — checked table by table before removal, against both repositories.
--
-- They were here because these features WERE the engine before they were
-- extracted, and every one of them left this behind. The cost was not
-- theoretical: whichever side migrated first won the shape, and the extension
-- patched the difference with ADD COLUMN IF NOT EXISTS on every install. Where
-- the patch was incomplete it broke — see migration 048 and zv_import_logs,
-- where an import failed at its first statement because the engine's column
-- was `file_format` and the extension's code said `format`.
--
-- Four later migrations (011, 020, 036, 037) altered some of these tables.
-- They now no-op when the table is absent rather than failing a fresh install.

-- ── from 002_insights_panels_title.sql ─────────────────────────────

-- Migration: 002_insights_panels_title
--
-- Fixes the `zv_panels.title` gap left by 069_insights_reconcile in
-- 001_initial.sql. The original reconcile added missing dashboard columns
-- after 026/067 schema divergence, but forgot panels: 026 created the
-- table with `name TEXT NOT NULL` and 067 wanted `title TEXT NOT NULL`,
-- but only 067's CREATE TABLE was a no-op (table existed) and 069 only
-- reconciled dashboards.
--
-- Every fresh install before this migration ended up with `zv_panels.name`
-- (NOT NULL) and no `title` column, so /api/insights/panels INSERT/UPDATE
-- handlers (which use `title`) 500ed at runtime with
-- "column title does not exist".
--
-- The reconcile in 001_initial.sql is updated to do this on fresh installs;
-- this migration is the same operation for installs that already applied
-- 001_initial.sql (alpha.99 through alpha.101 inclusive).

ALTER TABLE zv_panels ADD COLUMN IF NOT EXISTS title TEXT;
UPDATE zv_panels SET title = name WHERE title IS NULL AND name IS NOT NULL;
ALTER TABLE zv_panels ALTER COLUMN name DROP NOT NULL;

-- ── from 004_invitations.sql ───────────────────────────────────────

-- Migration: 004_invitations
--
-- Adds the missing zv_invitations table. The POST /api/users/invite
-- route was already INSERTing into it and the response URL pointed at
-- /accept-invite?token=…, but no migration ever created the table and
-- no route handled the accept side. Every invite would hit the catch
-- block ("Table may not exist yet — fall back to returning the
-- token directly") which made the flow look graceful from the API
-- response but actually meant nothing was ever persisted and the
-- token was useless against the (also missing) accept endpoint.
--
-- This migration creates the storage. A companion route
-- POST /api/auth/accept-invite consumes the rows.

CREATE TABLE IF NOT EXISTS zv_invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'member',
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  invited_by  TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_invitations_token   ON zv_invitations(token);
CREATE INDEX IF NOT EXISTS idx_zv_invitations_email   ON zv_invitations(email);
CREATE INDEX IF NOT EXISTS idx_zv_invitations_expires ON zv_invitations(expires_at)
  WHERE accepted_at IS NULL;

-- ── from 005_flow_dlq.sql ──────────────────────────────────────────

-- Migration: 005_flow_dlq
--
-- Adds the missing zv_flow_dlq (Dead Letter Queue) table that
-- routes/flows.ts has been reading + writing all along.
--
-- The DbSchema interface declared ZvFlowDlqTable so Kysely typecheck
-- passed, but no migration ever created the physical table. The DLQ
-- handlers (`GET /api/flows/dlq`, `POST /api/flows/dlq/:id/retry`) and
-- the executor's failure-path INSERTs would 500 at runtime against a
-- real Postgres. As with most extension routes, these failures were
-- wrapped in implicit `.catch()` chains or just bubbled up as 500s
-- the operator never read.

CREATE TABLE IF NOT EXISTS zv_flow_dlq (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id      UUID        NOT NULL REFERENCES zv_flows(id) ON DELETE CASCADE,
  payload      JSONB       NOT NULL DEFAULT '{}',
  error        TEXT,
  attempt_count INTEGER     NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_flow_dlq_flow ON zv_flow_dlq(flow_id, created_at DESC);

-- ── from 006_extension_load_errors.sql ─────────────────────────────

-- Migration: 006_extension_load_errors
--
-- Persist per-extension load failures so they survive a restart and surface
-- in /api/extensions (marketplace red badge + reason) instead of being a
-- silent skip. Previously the loader kept `lastLoadError` only in memory, and
-- the enable handler reacted to a transient hot-load failure by flipping
-- is_enabled=false — permanently disabling extensions that would have loaded
-- fine on the next boot (npm-install timing, dependency order, missing PG ext).
-- With the error persisted, the enable path can keep is_enabled=true and let
-- boot-load self-heal, while the operator still sees what went wrong.

ALTER TABLE zv_extension_registry
  ADD COLUMN IF NOT EXISTS last_load_error TEXT,
  ADD COLUMN IF NOT EXISTS last_load_at    TIMESTAMPTZ;

-- ── from 007_default_tenant.sql ────────────────────────────────────

-- Multi-tenant foundation (beta.18): the implicit default tenant.
--
-- "Always one tenant" model: every install has a default tenant. Single-tenant
-- deployments resolve to it on every request, so the `zveltio.current_tenant`
-- GUC is always set and RLS is uniform. The fixed UUID matches DEFAULT_TENANT_ID
-- in tenant-manager.ts and the collection-table column default applied by the
-- boot RLS reconciler.

INSERT INTO zv_tenants (id, slug, name, plan, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Default', 'enterprise', 'active')
ON CONFLICT (id) DO NOTHING;

-- ── from 008_casbin_domains.sql ────────────────────────────────────

-- Casbin RBAC-with-domains (beta.19). Reshape existing policies into the
-- 4-token form, placing every pre-existing policy/grant in domain '*' (applies
-- in EVERY tenant) so authorization is byte-for-byte unchanged. Per-tenant
-- policies use a concrete tenant id and are purely additive.
--
-- zvd_permissions is a GLOBAL infra table (Casbin policy store), not per-tenant
-- data — it is intentionally NOT row-level-security'd.
--
-- Layout change:
--   p (policy):  v0=sub, v1=obj, v2=act          →  v0=sub, v1=dom, v2=obj, v3=act
--   g (grant):   v0=user, v1=role                →  v0=user, v1=role, v2=dom
--
-- Postgres evaluates the SET right-hand sides against the pre-UPDATE row, so the
-- shift below is correct. The `v3 IS NULL` / `v2 IS NULL` guards make it
-- idempotent (a row already in 4-token form is skipped).

-- The policy-uniqueness index covered (ptype, v0, v1, v2) — but `act` moves to
-- v3 in the 4-token layout, so two policies sharing (sub, obj) and differing
-- only in `act` would collide on (sub, '*', obj) after the reshape. Drop it
-- first, reshape, then recreate it INCLUDING v3 (full 4-token uniqueness).
DROP INDEX IF EXISTS idx_zvd_permissions_policy_unique;

UPDATE zvd_permissions
   SET v3 = v2, v2 = v1, v1 = '*'
 WHERE ptype = 'p' AND v3 IS NULL;

UPDATE zvd_permissions
   SET v2 = '*'
 WHERE ptype = 'g' AND v2 IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_zvd_permissions_policy_unique
  ON zvd_permissions (ptype, COALESCE(v0, ''), COALESCE(v1, ''), COALESCE(v2, ''), COALESCE(v3, ''));

-- ── from 009_tenant_role_policies.sql ──────────────────────────────

-- Standard tenant-role policies (beta.22). These define what each tenant role
-- CAN do; they live at domain '*' so they apply wherever a user holds the role.
-- Per-tenant membership (/api/tenants/:id/members) grants a user a tenant role IN
-- a specific tenant's domain (g, user, tenant_<role>, <tenantId>), scoping the
-- permission to that tenant.
--
-- The Casbin role names are NAMESPACED (`tenant_*`) so they never collide with —
-- or escalate — the pre-existing global roles (`admin`, `member`) seeded in 001.
--
-- 4-token layout (post-008): p = sub(role), dom, obj, act.

INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3) VALUES
  ('p', 'tenant_owner',  '*', '*', '*'),
  ('p', 'tenant_admin',  '*', '*', '*'),
  ('p', 'tenant_member', '*', '*', 'read'),
  ('p', 'tenant_member', '*', '*', 'create'),
  ('p', 'tenant_member', '*', '*', 'update'),
  ('p', 'tenant_viewer', '*', '*', 'read')
ON CONFLICT DO NOTHING;

-- ── from 010_media_tenant_isolation.sql ────────────────────────────

-- Migration 010: tenant isolation for media files + folders.
--
-- zv_media_files / zv_media_folders shipped as flat GLOBAL tables (no tenant_id,
-- no RLS). routes/storage.ts and routes/media.ts query them by id/folder_id only,
-- so in a multi-tenant deployment any authenticated user could list/view/download
-- (signed URL)/transform/DELETE another tenant's media by id — a cross-tenant IDOR.
--
-- Add a tenant_id scoped exactly like the RLS tables' default: NULLIF-guarded so a
-- blank `zveltio.current_tenant` GUC (single-tenant / no context) falls back to the
-- default tenant instead of crashing on ''::uuid. Existing rows backfill to the
-- default tenant. The route handlers additionally filter every read/delete by the
-- request's tenant id (explicit scoping — no FORCE RLS, so background media jobs
-- that run without a tenant GUC are unaffected).

ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_media_files
  SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
  WHERE tenant_id IS NULL;
ALTER TABLE zv_media_files
  ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
           '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_tenant ON zv_media_files(tenant_id);

ALTER TABLE zv_media_folders ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_media_folders
  SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
  WHERE tenant_id IS NULL;
ALTER TABLE zv_media_folders
  ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
           '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_media_folders_tenant ON zv_media_folders(tenant_id);

-- ── from 012_media_tags_tenant_isolation.sql ───────────────────────

-- Migration 012: tenant isolation for media tags (completes the media cluster
-- started in 010, which covered zv_media_files + zv_media_folders).
--
-- zv_media_tags / zv_media_file_tags had no tenant_id, so routes/media.ts listed
-- ALL tenants' tags, and PUT/DELETE /tags/:id could rename/delete another tenant's
-- tags by id (cross-tenant). Add tenant_id (NULLIF-guarded default) + backfill; the
-- handlers scope every tag read/write by the request tenant.

ALTER TABLE zv_media_tags ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_media_tags SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_media_tags ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_media_tags_tenant ON zv_media_tags(tenant_id);
-- Tag names were GLOBALLY unique — under multi-tenancy each tenant needs its own
-- name namespace (otherwise one tenant's tag name blocks another's + leaks existence).
ALTER TABLE zv_media_tags DROP CONSTRAINT IF EXISTS zv_media_tags_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS zv_media_tags_tenant_name_key ON zv_media_tags(tenant_id, name);

ALTER TABLE zv_media_file_tags ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_media_file_tags SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_media_file_tags ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_media_file_tags_tenant ON zv_media_file_tags(tenant_id);

-- ── from 013_dashboards_tenant_isolation.sql ───────────────────────

-- Migration 013: tenant isolation for insights dashboards.
--
-- zv_dashboards had no tenant_id, and routes/insights.ts lists `WHERE
-- d.is_public = true OR created_by = me OR shared`, so a PUBLIC dashboard was
-- visible to authenticated users of EVERY tenant (cross-tenant leak), and the
-- by-id read/update/delete/share handlers found dashboards across tenants.
-- Panels and shares are always reached through a dashboard lookup, so scoping the
-- dashboard (below + in the handler) transitively protects them.

ALTER TABLE zv_dashboards ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_dashboards SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_dashboards ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_dashboards_tenant ON zv_dashboards(tenant_id);

-- ── from 014_flows_tenant_isolation.sql ────────────────────────────

-- Migration 014: tenant isolation for flows (workflow automation) — route level.
--
-- zv_flows shipped as a flat GLOBAL table (no tenant_id, no RLS). routes/flows.ts
-- lists all flows and reaches them by id on the raw pool db, so in a multi-tenant
-- deployment any admin could read/patch/delete/run another tenant's flows by id
-- and enumerate the whole flow list (cross-tenant IDOR).
--
-- zv_flow_steps / zv_flow_runs / zv_flow_dlq are ALWAYS reached through a flow
-- (by flow_id), so scoping the flow (below + in the handlers, and by joining the
-- child reads to zv_flows) transitively protects them. They are intentionally NOT
-- given their own tenant_id here: the flow executor / scheduler write runs and DLQ
-- entries from a background context with no request tenant, so a DEFAULT-based
-- column would mis-tag those rows with the default tenant. Threading the flow's own
-- tenant_id through executeFlow (and adding columns there) is the separate executor
-- pass; this migration only closes the directly-exposed route surface.

ALTER TABLE zv_flows ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_flows SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_flows ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_flows_tenant ON zv_flows(tenant_id);

-- ── from 015_edge_functions_tenant_isolation.sql ───────────────────

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

-- ── from 016_webhooks_tenant_isolation.sql ─────────────────────────

-- Migration 016: tenant isolation for webhooks.
--
-- zvd_webhooks / zvd_webhook_deliveries had no tenant_id, so:
--   1. routes/webhooks.ts (raw pool, admin-gated but admin is PER-TENANT) listed
--      EVERY tenant's webhooks and let GET/PATCH/DELETE/test/rotate-secret reach
--      another tenant's webhook by id → cross-tenant IDOR (config + rotate-secret
--      returns the plaintext signing key).
--   2. WORSE — lib/webhooks.ts WebhookManager.trigger() selected matching
--      webhooks across ALL tenants, so a data write in tenant A fired tenant B's
--      webhook → B's endpoint received A's record data (cross-tenant data
--      exfiltration).
-- Add tenant_id (NULLIF-guarded default) + backfill; the route scopes every
-- read/write by the request tenant and the dispatcher filters by the writing
-- tenant (threaded from afterWrite, same as the WS/SSE broadcasts).

ALTER TABLE zvd_webhooks ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zvd_webhooks SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zvd_webhooks ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zvd_webhooks_tenant ON zvd_webhooks(tenant_id);

ALTER TABLE zvd_webhook_deliveries ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zvd_webhook_deliveries SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zvd_webhook_deliveries ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zvd_webhook_deliveries_tenant ON zvd_webhook_deliveries(tenant_id);

-- ── from 018_revisions_tenant_isolation.sql ────────────────────────

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

-- ── from 019_saved_queries_import_tenant_isolation.sql ─────────────

-- Migration 019: tenant isolation for saved queries + import logs
-- (closes the engine-route tenant-isolation campaign).
--
-- zv_saved_queries: routes scoped reads by `created_by = user OR is_shared`, but
--   `is_shared` was GLOBAL — a query shared in tenant B was visible to tenant A.
--   Sharing must be per-ORGANIZATION, so scope every access by tenant_id and let
--   is_shared mean "shared within this tenant".
-- zv_import_logs: the list handler only narrowed to `created_by` for non-admins,
--   so a tenant admin saw EVERY tenant's import logs (filenames, collections,
--   error rows), and the status-update handlers reached a log by raw id.
-- Add tenant_id (NULLIF-guarded default) + backfill; handlers scope by tenant.

ALTER TABLE zv_saved_queries ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_saved_queries SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_saved_queries ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_saved_queries_tenant ON zv_saved_queries(tenant_id);

ALTER TABLE zv_import_logs ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_import_logs SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_import_logs ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_import_logs_tenant ON zv_import_logs(tenant_id);

-- ── from 021_api_keys_invitations_tenant_isolation.sql ─────────────

-- Migration 021: tenant isolation for API keys + invitations.
--
-- zv_api_keys: the management routes (admin.ts + admin/system-routes.ts) list,
--   revoke (DELETE /:id) and patch keys by raw id against the un-scoped pool, so
--   a tenant admin saw EVERY tenant's keys and could revoke/patch another
--   tenant's key by id (cross-tenant IDOR). We add tenant_id and scope every
--   management handler by the request tenant.
-- zv_invitations: created per-tenant (users.ts) but the accept/lookup path
--   reaches an invite purely by token; add tenant_id so an accepted invite lands
--   the new member in the inviting tenant rather than the default one.
--
-- NOTE: no DB-level RLS here on purpose. zv_api_keys is read by the API-key auth
--   guard BEFORE tenant resolution runs (the GUC is still unset at that point);
--   a strict RLS policy would return zero rows and break API-key auth entirely.
--   Isolation is enforced at the route layer, mirroring migration 019.

ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_api_keys SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_api_keys ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_api_keys_tenant ON zv_api_keys(tenant_id);

ALTER TABLE zv_invitations ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE zv_invitations SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE tenant_id IS NULL;
ALTER TABLE zv_invitations ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid);
CREATE INDEX IF NOT EXISTS idx_zv_invitations_tenant ON zv_invitations(tenant_id);

-- ── from 022_extension_granted_capabilities.sql ────────────────────

-- Record which capabilities an administrator actually consented to.
--
-- The manifest DECLARES capabilities; this column records what was GRANTED.
-- Without the distinction, an extension can ship v1 declaring nothing and v2
-- declaring `db:admin`, and an update hands it cross-tenant database access
-- with nobody deciding anything. Consent has to be stored to be meaningful.
--
-- NULL means "no consent recorded" and is grandfathered at load: every install
-- that predates this column keeps running with what its manifest declares.
-- Refusing those would turn an engine upgrade into an outage for a decision
-- nobody was ever asked to make. Consent is recorded from the next install,
-- enable or approval onwards.
ALTER TABLE zv_extension_registry
  ADD COLUMN IF NOT EXISTS granted_capabilities JSONB;

COMMENT ON COLUMN zv_extension_registry.granted_capabilities IS
  'Capabilities an admin consented to, as a JSON array of strings. NULL = pre-consent install (grandfathered). The effective set at load is granted ∩ declared.';

-- ── from 023_extension_digest_pin.sql ──────────────────────────────

-- Pin the artifact digest an extension was actually installed from.
--
-- The download path already verifies the registry's declared SHA-256 and the
-- registry's signature. Both compare against what the registry is serving
-- TODAY: a registry that re-publishes different content under an existing
-- version passes them, because it declares and signs the new bytes honestly.
-- Only a record of what was installed catches a version whose contents changed.
--
-- The rule is "the same version is always the same bytes". A genuinely new
-- version carries a new digest and re-pins, which is visible to the
-- administrator as a version change.
ALTER TABLE zv_extension_registry
  ADD COLUMN IF NOT EXISTS installed_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS installed_version TEXT;

COMMENT ON COLUMN zv_extension_registry.installed_sha256 IS
  'SHA-256 of the archive this extension was installed from. Re-downloading the same installed_version must produce the same digest.';

-- ── from 024_flow_reader_role.sql ──────────────────────────────────

-- A database role for flow `query_db` steps, with no access to auth tables.
--
-- `query_db` runs operator-authored SQL. It is already read-only (SET
-- TRANSACTION READ ONLY) and scoped to the caller's tenant for collection data
-- — but the tenant GUC only governs `zvd_*` rows. Better-Auth's `session`,
-- `user` and `account` tables have no RLS, so "read-only and tenant-scoped" was
-- true of collection data and of nothing else: `SELECT token FROM "session"`
-- returned every live session on the instance, god sessions included.
--
-- Authorship is now gated (instance admins only), which contains it. This is
-- the actual boundary: Postgres refuses the read regardless of who wrote the
-- query or how it is shaped. Same lesson as the data-modifying CTE that walked
-- through a regex guard — the database enforces, the string check advises.
--
-- The grant is an ALLOWLIST (`zvd_*` collection tables only), not a denylist of
-- sensitive tables. A denylist means every future system table is readable
-- until someone remembers to add it; an allowlist means a new *collection* that
-- is missed becomes unreadable to flows, which surfaces immediately as a broken
-- report rather than silently as a leak.
--
-- Best-effort by design. A managed Postgres where the application user cannot
-- CREATE ROLE would otherwise fail this migration and block the upgrade
-- entirely. When the role is absent the executor logs and falls back to the
-- authorship gate — defence in depth, where the outer layer always holds.
DO $$
DECLARE
  t record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_flow_reader') THEN
    CREATE ROLE zveltio_flow_reader NOLOGIN;
  END IF;

  -- The connecting user must be a member to `SET ROLE` to it.
  EXECUTE format('GRANT zveltio_flow_reader TO %I', current_user);

  GRANT USAGE ON SCHEMA public TO zveltio_flow_reader;

  -- Existing collection tables. New ones are granted by DDLManager at create
  -- time; see grantFlowReaderSelect().
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'zvd\_%'
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO zveltio_flow_reader', t.tablename);
  END LOOP;

  -- Belt and braces: an explicit REVOKE on the tables this exists to protect,
  -- in case a future default-privilege change hands out blanket SELECT.
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename IN ('session', 'user', 'account', 'verification')
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM zveltio_flow_reader', t.tablename);
  END LOOP;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'zveltio_flow_reader not created (insufficient privilege). Flow query_db steps stay gated by authorship only — see 024_flow_reader_role.sql.';
END
$$;

-- ── from 026_api_key_rls_bypass.sql ────────────────────────────────

-- Make the API-key RLS bypass an explicit, per-key decision.
--
-- `getRlsFilters` returned no filters at all for `authType === 'api_key'`, so
-- every key ignored every row-level policy. Unlike the god half of that same
-- condition — which was dead because `session.user.role` is undefined — this
-- half was live: an operator who wrote "users see only their own records" got
-- exactly that for people and no constraint at all for integrations, with
-- nothing in the UI saying so.
--
-- Defaults to TRUE, which is precisely today's behaviour. That is deliberate,
-- not timidity: RLS policies resolve their values from `user_id` / `user_email`
-- (see resolveValue), and a key's identity is the synthetic `apikey:<uuid>`,
-- which matches no real user. Enforcing such a policy against a key does not
-- make it safer — it makes it return ZERO rows, silently, and every integration
-- built on that key stops working without an error to point at. Empty results
-- are a worse failure than broad ones because nothing surfaces them.
--
-- What changes is that the bypass is now data: visible per key, revocable, and
-- meaningful to turn off for keys whose collections use `static:` or
-- `user_role` policies, which a machine credential CAN satisfy.
ALTER TABLE zv_api_keys
  ADD COLUMN IF NOT EXISTS rls_bypass BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN zv_api_keys.rls_bypass IS
  'When true (default) this key is not constrained by row-level security policies. Turn off for keys whose collections use identity-independent policies.';

-- ── from 027_validation_rules_safe_activation.sql ──────────────────

-- Validation rules start enforcing. Existing ones do not.
--
-- `zv_validation_rules` shipped with a management UI, an extension, a rule
-- engine and this table — and nothing ever called `validateRecord`. An
-- administrator could write a rule, see it listed as active, and it did
-- nothing. The constraint they believed they had put in place was not there.
--
-- `processInput` now applies them, which is the single point every write goes
-- through (the API handlers, import, and sync). That is the fix, and on its own
-- it would be a nasty upgrade: every rule anyone ever saved, on any install,
-- would begin rejecting writes that have been succeeding for months. Nobody
-- authored those rules against enforcement — they never saw one refuse
-- anything — so there is no reason to believe the data conforms to them.
--
-- So the feature is switched on for rules written from here, and off for rules
-- written before. An operator re-enables the ones they still want, having seen
-- the release note, one at a time, on a system where turning one on has a
-- visible effect. New rules are active by default (the column default is
-- unchanged), so the UI behaves as it always claimed to.
--
-- Idempotent: re-running only touches rows that were created before this
-- migration first ran, and after the first run there are none left with
-- `is_active = TRUE` from that era.

DO $$
DECLARE
  affected INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'zv_validation_rules'
  ) THEN
    RETURN;
  END IF;

  UPDATE zv_validation_rules
     SET is_active = FALSE,
         updated_at = NOW()
   WHERE is_active = TRUE
     AND created_at < NOW();

  GET DIAGNOSTICS affected = ROW_COUNT;

  IF affected > 0 THEN
    RAISE WARNING
      'Validation rules are now enforced on writes. % pre-existing rule(s) were '
      'DISABLED so this upgrade does not start rejecting writes against rules that '
      'never ran. Review them in Studio (Developer -> Validation) and re-enable the '
      'ones you want: UPDATE zv_validation_rules SET is_active = TRUE WHERE id = ''<id>'';',
      affected;
  END IF;
END $$;

-- ── from 028_media_file_visibility.sql ─────────────────────────────

-- Files stop being visible to the whole tenant by default.
--
-- `GET /api/media/files` required a session and nothing else: no permission
-- check, no owner filter. So every authenticated user could list and download
-- every file any colleague had ever uploaded. On a Business OS for companies
-- and public institutions that is not a rough edge — it is HR's scanned ID,
-- finance's payroll export, and legal's draft contract, readable by anyone with
-- a login.
--
-- The reason it was not obviously wrong is that `zv_media_files` serves two
-- purposes through one table. A CMS asset library WANTS tenant-wide reach: an
-- editor uploads the logo and everyone uses it. Personal storage does not.
-- Nothing in the schema said which a given row was, so the code could only pick
-- one answer for both, and it picked the permissive one.
--
--   tenant   — the shared library. Anyone in the tenant may read it.
--   personal — the uploader's own. Only they and a tenant admin may read it.
--
-- DEFAULT is `personal`: a file whose purpose nobody declared is the
-- uploader's. The media-library route sets `tenant` explicitly, as does the
-- storage route for a PUBLIC upload — those are served without authentication
-- anyway, so hiding them from a listing would be theatre.
--
-- Existing rows are backfilled to `tenant`. They were readable tenant-wide
-- yesterday, and an upgrade that silently hides files people were working with
-- is its own kind of broken. Operators narrow them deliberately.
--
-- Not addressed here, deliberately: sharing a personal file with a NAMED
-- colleague. `zv_media_shares` is link-based — token, password, expiry,
-- download cap — which covers "send this to someone" and not "give my teammate
-- access". That needs a per-file ACL and is a separate piece of work.

ALTER TABLE zv_media_files
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'personal';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'zv_media_files_visibility_check'
  ) THEN
    ALTER TABLE zv_media_files
      ADD CONSTRAINT zv_media_files_visibility_check
      CHECK (visibility IN ('tenant', 'personal'));
  END IF;
END $$;

-- Backfill only what predates the column. Rows created after it exist already
-- carry the value their upload route chose, so this must not touch them —
-- hence the one-shot guard rather than a blanket UPDATE.
DO $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE zv_media_files
     SET visibility = 'tenant'
   WHERE visibility = 'personal'
     AND created_at < (
       SELECT COALESCE(MIN(applied_at), NOW())
       FROM zv_schema_versions
       WHERE version = 28
     );
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE WARNING
      'Media files are now personal by default. % pre-existing file(s) were kept '
      'tenant-visible so nothing that worked yesterday disappears. Narrow them in '
      'Studio, or: UPDATE zv_media_files SET visibility = ''personal'' WHERE id = ''<id>'';',
      affected;
  END IF;
END $$;

-- Listings filter on (tenant_id, visibility) and on (tenant_id, created_by).
CREATE INDEX IF NOT EXISTS idx_zv_media_files_visibility
  ON zv_media_files (tenant_id, visibility);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_owner
  ON zv_media_files (tenant_id, created_by);

-- ── from 029_tenant_scope_predicate.sql ────────────────────────────

-- 029_tenant_scope_predicate.sql
--
-- One definition of "may this row be seen in this tenant context".
--
-- There were two, and they disagreed on the case that matters. The engine's own
-- collection tables use
--
--     USING (tenant_id::text = current_setting('zveltio.current_tenant', true))
--
-- which is fail-CLOSED: no tenant context, no rows. Every extension shipped its
-- own `002_tenant_rls.sql` from a copied template that reads
--
--     USING (NULLIF(current_setting(...), '') IS NULL   -- ← every row
--            OR tenant_id IS NULL                       -- ← every row
--            OR tenant_id::text = current_setting(...))
--
-- which is fail-OPEN, in all 54 of them. So a query that reached an extension's
-- table without opening the tenant transaction — and 31 of 53 extensions hold a
-- bare `db` where they meant `reqDb(c)` — read every tenant's rows instead of
-- none. The identical mistake against an engine table returned an empty set and
-- got noticed. Same rule, two spellings, opposite behaviour on the only case
-- anybody cares about.
--
-- The fail-open clause was not an oversight; the template documents it as the
-- "single-tenant fallback", and that intent is real. On an install with no
-- tenant routing there is no middleware transaction and no GUC, so a
-- fail-closed policy returns nothing at all — and self-hosted single-tenant is
-- the primary deployment. Measured on Postgres 18: a straight flip does break
-- it.
--
-- What both spellings missed is that the engine already answers this question
-- elsewhere, in the tenant_id column DEFAULT that migration 007 and
-- tenant-manager.ts install:
--
--     COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
--              '00000000-0000-0000-0000-000000000001'::uuid)
--
-- "the current tenant, and absent context, the default tenant". Rows are
-- WRITTEN under that rule, so reading them under the same rule is the only
-- spelling that cannot disagree with itself. That is all this predicate is.
--
--   GUC set   → the row must belong to that tenant.
--   GUC unset → the row must belong to the DEFAULT tenant. On a single-tenant
--               install that is every row, so nothing changes. On an install
--               with real tenants, a contextless query now reads the default
--               tenant's data instead of everyone's — still a bug in the
--               caller, but no longer a cross-tenant disclosure.
--
-- Rows with a NULL tenant_id become invisible rather than universally visible.
-- The reconciler backfills them to the default tenant first, exactly as
-- migration 007 did for the engine's own tables, so this closes a hole instead
-- of hiding data.
--
-- Written as a function on purpose: the next change to this rule happens in one
-- place instead of in 54 files that will disagree again. Postgres inlines it —
-- the plan shows the bare expression and the buffer count is identical to no
-- policy at all (measured: 200k rows, 1471 buffers either way).

CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT row_tenant = COALESCE(
    NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid
  )
$$;

COMMENT ON FUNCTION zveltio_tenant_scope_ok(uuid) IS
  'Single source of truth for tenant row visibility, mirroring the tenant_id '
  'column DEFAULT so reads and writes cannot disagree. Used by tenant_isolation '
  'policies on engine and extension tables alike. See migration 029.';

-- ── from 030_rls_enforcement_role.sql ──────────────────────────────

-- A database role that Postgres will actually apply RLS to.
--
-- Everything about tenant isolation in this codebase assumes FORCE ROW LEVEL
-- SECURITY binds the engine's connection. It does not, on a default install.
--
-- `docker-compose.yml` sets `POSTGRES_USER: ${POSTGRES_USER:-zveltio}`, and the
-- official Postgres image creates that user as a SUPERUSER — that is what the
-- variable means to the image's entrypoint. FORCE RLS does not bind superusers,
-- and neither does anything else. So on every stock deployment the isolation
-- policies are commentary: the reconcilers install them, `warnIfDbRoleBypassesRls`
-- prints a warning at boot that scrolls past in the startup log, and every query
-- reads every tenant's rows anyway.
--
-- This is underneath the whole tenant-isolation category of the 2026-08-03
-- audit. Fixing the policies — which the audit asked for and migration 029 did —
-- changes nothing at all while the connection is exempt from them.
--
-- The fix is not to tell operators to reconfigure their database. It is to stop
-- depending on how they configured it: the engine drops to a plain role for the
-- duration of each tenant transaction, so RLS applies whatever the connection
-- happens to be. `withTenantIsolation` issues `SET LOCAL ROLE zveltio_rls`
-- immediately after BEGIN, and the role reverts when the transaction ends.
--
-- The precedent is `zveltio_flow_reader` (migration 024), which does the same
-- thing for `query_db` steps. This applies it to the path every request takes.
--
-- Scope note: schema-management routes (`/api/collections`, `/api/relations`,
-- `/api/schema`, `/api/templates`) deliberately do NOT open a tenant
-- transaction — see TXN_SKIP_PREFIXES — so DDL never runs under this role and
-- keeps the owner's rights. Only tenant DATA access is downgraded, which is
-- exactly the access RLS is meant to govern.
--
-- Best-effort, like 024: a managed Postgres where the application user cannot
-- CREATE ROLE must not fail the migration and block the upgrade. When the role
-- is absent the engine logs at boot and behaves as it does today.
DO $$
DECLARE
  t record;
  s record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_rls') THEN
    -- NOSUPERUSER and NOBYPASSRLS are the entire point; spelled out rather than
    -- left to defaults so a future edit cannot quietly undo it.
    CREATE ROLE zveltio_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- The connecting user must be a member to `SET ROLE` to it.
  EXECUTE format('GRANT zveltio_rls TO %I', current_user);

  GRANT USAGE ON SCHEMA public TO zveltio_rls;

  -- DML on everything the engine reads or writes inside a request. Not DDL:
  -- this role is for data access, and schema changes run outside the tenant
  -- transaction.
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO zveltio_rls', t.tablename);
  END LOOP;

  -- Serial primary keys need the sequence, or every INSERT fails with
  -- "permission denied for sequence".
  FOR s IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO zveltio_rls', s.sequencename);
  END LOOP;

  -- Tables created later — by a collection, or by an extension's migrations —
  -- must be reachable too, or the first write to a new collection fails. Default
  -- privileges apply to objects this role creates from now on.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zveltio_rls', current_user);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT USAGE, SELECT ON SEQUENCES TO zveltio_rls', current_user);
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'zveltio_rls not created (insufficient privilege). If the engine connects as a SUPERUSER, row-level security is NOT enforced — see 030_rls_enforcement_role.sql.';
END
$$;

-- ── from 031_insight_saved_queries_tenant.sql ──────────────────────

-- 031_insight_saved_queries_tenant.sql
--
-- Insights saved queries belong to a tenant.
--
-- Migration 019 tenant-scoped `zv_saved_queries` and explained why: "sharing
-- must be per-ORGANIZATION, so scope every access by tenant_id". It did not
-- touch `zvd_insight_saved_queries`, a different table with a nearly identical
-- name holding the same kind of thing — user-authored SQL, marked public or
-- private, executable by id.
--
-- So `POST /insights/saved-queries/:id/execute` looked the row up by id alone,
-- allowed it if `is_public`, and ran the text. Any authenticated user could
-- execute any other tenant's public saved query, and the SQL itself ran on the
-- global pool with no tenant context, so it returned every tenant's rows.
--
-- Two layers of the same hole: the row was reachable across tenants, and the
-- query it contained was unscoped when it ran. This closes the first; the route
-- change closes the second by executing under the caller's tenant.
--
-- `zvd_insight_dashboards` already has the column, which is why panels were
-- looked up correctly and only their SQL leaked. One table in a pair got the
-- fix and its twin did not.

ALTER TABLE zvd_insight_saved_queries
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE zvd_insight_saved_queries
   SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;

ALTER TABLE zvd_insight_saved_queries
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid
  );

ALTER TABLE zvd_insight_saved_queries
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_zvd_insight_saved_queries_tenant
  ON zvd_insight_saved_queries (tenant_id);

-- Route handlers scope by tenant explicitly; this is the second lock, on the
-- host's shared predicate (migration 029) and bound by the enforcement role
-- (migration 030).
ALTER TABLE zvd_insight_saved_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE zvd_insight_saved_queries FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_zvd_insight_saved_queries
  ON zvd_insight_saved_queries;
CREATE POLICY tenant_isolation_zvd_insight_saved_queries
  ON zvd_insight_saved_queries
  USING (zveltio_tenant_scope_ok(tenant_id))
  WITH CHECK (zveltio_tenant_scope_ok(tenant_id));

-- ── from 032_api_key_rls_bypass_default_off.sql ────────────────────

-- 032_api_key_rls_bypass_default_off.sql
--
-- A new API key is subject to row-level security unless someone says otherwise.
--
-- Migration 026 added `rls_bypass` with `DEFAULT true`, preserving what keys
-- did before the column existed. That was the right call for keys that already
-- existed and the wrong one for every key created since: creating a key the
-- ordinary way — a name and some scopes — produced a credential that row
-- policies did not apply to, and nothing in the request or the UI said so.
--
-- The default flips. Keys already in the table keep whatever value they were
-- created with, since a column DEFAULT does not touch existing rows: this
-- changes what happens NEXT, not what an operator already deployed.
--
-- The cost, stated plainly: a key against a collection with identity-based
-- policies (`user_id`, `owner`) now matches no rows, because a machine
-- credential has no identity for the policy to compare against. That key needs
-- `rls_bypass: true` explicitly — which is the case the flag was added for.

ALTER TABLE zv_api_keys
  ALTER COLUMN rls_bypass SET DEFAULT false;

COMMENT ON COLUMN zv_api_keys.rls_bypass IS
  'Exempt this key from row-level security. Defaults to FALSE (migration 032): '
  'set it explicitly for keys whose collections use identity-based policies, '
  'which a machine credential can never satisfy.';

-- ── from 033_tenant_scope_predicate_text.sql ───────────────────────

-- 033_tenant_scope_predicate_text.sql
--
-- A TEXT overload of the tenant visibility rule.
--
-- Migration 029 typed `zveltio_tenant_scope_ok` on uuid, which is what a
-- tenant_id ought to be and what 289 of the 292 declarations in the ecosystem
-- say. The other three do not: `billing` declares `tenant_id TEXT` on two
-- tables and UUID on a third, and the engine's own `zv_extension_registry`
-- uses TEXT. Nobody had noticed, because the predicate everyone used compared
-- `tenant_id::text` and accepted either. Typing 029 properly turned that
-- inconsistency into a migration failure — `function
-- zveltio_tenant_scope_ok(text) does not exist` — which is the right way for
-- it to surface and the wrong thing to leave as the extension author's
-- problem.
--
-- Extensions are installed from a registry onto engines their author never
-- sees, so the host absorbs this: the rule stays one rule, offered at two entry
-- points, and a third-party table works whichever type it happens to use.
--
-- A separate migration rather than an edit to 029 because 029 has shipped.
-- Migrations run once, by number, so appending to an applied file reaches only
-- installs that had not run it yet — the ones that had would be missing the
-- overload with nothing to tell them.

-- The same rule for a `tenant_id` that is TEXT rather than UUID.
--
-- Not hypothetical: `billing` declares `tenant_id TEXT` on two of its tables
-- and UUID on a third, and the engine's own `zv_extension_registry` uses TEXT.
-- Nobody noticed because the predicate everyone had been using compared
-- `tenant_id::text`, which accepts either. Typing this one properly surfaced
-- the inconsistency as a migration failure — the right outcome, and it must not
-- be the extension author's problem to fix.
--
-- Extensions come from a registry and run on engines their author never sees,
-- so an overload is the honest answer: the rule stays one rule, expressed at
-- both entry points, and a third-party table works whichever type it chose.
CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT row_tenant = COALESCE(
    NULLIF(current_setting('zveltio.current_tenant', true), ''),
    '00000000-0000-0000-0000-000000000001'
  )
$$;

COMMENT ON FUNCTION zveltio_tenant_scope_ok(text) IS
  'TEXT overload of the tenant visibility rule, for tables whose tenant_id is '
  'text rather than uuid. Same semantics as the uuid form. See migration 029.';

-- ── from 034_deny_by_default_grants.sql ────────────────────────────

-- Deny by default: replace the partial wildcards with the rows they stood for.
--
-- Migration 009 seeded the tenant roles as `('tenant_member', '*', '*', 'read')`
-- and the same for create and update. The enforcer now honours `*` on the object
-- only when the grant is total (`act = '*'`), so those four rows grant nothing —
-- and the twenty-three extensions that guard routes with
-- `permissionGate(ctx, '<resource>')` finally get an answer that depends on the
-- resource name. Before this, they did not: an ordinary member could read and
-- edit a colleague's national ID, IBAN, salary and home address.
--
-- The point of this migration is that the change is not supposed to be felt
-- anywhere else. Every resource that existed before gets written out
-- explicitly, so an operator upgrading keeps exactly the access they had, minus
-- the four resources listed as sensitive, which is the whole intent.
--
-- `tenant_owner` and `tenant_admin` are untouched. Their grant is `('*','*','*')`
-- — total, still matches everything, and has to: locking administrators out of
-- HR would not be confidentiality, it would be an outage.
--
-- Two namespaces have to be covered and only one is queryable. Collections live
-- in `zvd_collections`. Extension resources exist only as string literals in
-- extension source, so they are listed below; from here on an extension declares
-- them in its manifest and `scripts/check-extension-resources.ts` fails the build
-- on an undeclared one. A fresh install runs this with `zvd_collections` still
-- empty, which is correct — `materializeDefaultGrants` runs on every collection
-- creation and again at boot, so nothing depends on this migration having seen
-- the full picture.

-- Resources that stay closed until a role is granted them by name. Kept in step
-- with SENSITIVE_RESOURCES in lib/tenancy/permissions.ts.
CREATE TEMP TABLE _sensitive (name TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _sensitive (name) VALUES
  ('employees'), ('payroll'), ('leave'), ('banking');

CREATE TEMP TABLE _resources (name TEXT PRIMARY KEY) ON COMMIT DROP;

-- Collections, as they stand at upgrade time.
INSERT INTO _resources (name)
  SELECT name FROM zvd_collections
  ON CONFLICT DO NOTHING;

-- Extension resources: every distinct name passed to permissionGate() across the
-- 57 extensions when this landed. None of these is a collection — the two
-- namespaces are disjoint, so walking only zvd_collections would have closed all
-- twenty-eight of them.
INSERT INTO _resources (name) VALUES
  ('accounting'), ('api-connector'), ('assets'), ('banking'), ('checklists'),
  ('crm'), ('efactura'), ('employees'), ('etransport'), ('expenses'),
  ('export'), ('helpdesk'), ('import'), ('inventory'), ('invoices'),
  ('leave'), ('media'), ('payroll'), ('pos'), ('postgis'),
  ('procurement'), ('projects'), ('quotes'), ('ro-documents'), ('saft'),
  ('store'), ('subscriptions'), ('time-tracking')
  ON CONFLICT DO NOTHING;

-- Write out what the wildcards granted, resource by resource.
INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
  SELECT 'p', roles.role, '*', r.name, roles.action
  FROM _resources r
  CROSS JOIN (VALUES
    ('tenant_member', 'read'),
    ('tenant_member', 'create'),
    ('tenant_member', 'update'),
    ('tenant_viewer', 'read')
  ) AS roles(role, action)
  WHERE r.name NOT IN (SELECT name FROM _sensitive)
ON CONFLICT DO NOTHING;

-- And drop the wildcards themselves. They are inert under the new matcher; the
-- reason to remove them is that a policy table an operator reads should say what
-- it means. Scoped to these two roles and to a named action, so an
-- administrator's total grant is never touched.
DELETE FROM zvd_permissions
 WHERE ptype = 'p'
   AND v0 IN ('tenant_member', 'tenant_viewer')
   AND v1 = '*'
   AND v2 = '*'
   AND v3 <> '*';

-- ── from 035_widen_sensitive_resources.sql ─────────────────────────

-- Close four more resources that migration 034 had already opened.
--
-- Owner decision, 2026-08-07, after an audit measured what an ordinary
-- `tenant_member` could reach on a running instance. Expense reports carry
-- amounts, merchants and receipts per person — where somebody was and who with.
-- Time tracking is attendance. Accounting is the company's books, and invoicing
-- is its revenue. All four had default grants because nobody had decided
-- otherwise, which is the thing deny-by-default exists to stop.
--
-- Adding names to `SENSITIVE_RESOURCES` alone would have changed nothing here.
-- That set is consulted when a grant is CREATED, so it governs new resources and
-- new installs; the rows for these four were written by migration 034 minutes
-- after the rule landed and would simply have stayed. Withholding a future grant
-- and revoking an existing one are different operations, and only the second one
-- closes an instance that is already running.
--
-- Scoped to the two roles that received the automatic grant. A role an operator
-- created and granted by name — an `accountant` who should reach the books — is
-- untouched, which is the whole point of having made these rows explicit: they
-- can be told apart and removed individually.
--
-- `tenant_owner` and `tenant_admin` are unaffected. Their grant is total.
--
-- This is expected to take access away from people who had it, particularly for
-- invoicing, which in many companies is daily work. The remedy is one grant per
-- role, from the permissions UI, and it is a decision somebody makes once rather
-- than an accident everyone inherits.

DELETE FROM zvd_permissions
 WHERE ptype = 'p'
   AND v0 IN ('tenant_member', 'tenant_viewer')
   AND v1 = '*'
   AND v2 IN ('expenses', 'time-tracking', 'accounting', 'invoices');

-- ── from 037_user_ref_text.sql ─────────────────────────────────────

-- A user id does not fit in a uuid column.
--
-- `"user".id` is a 32-character nanoid and always was; these columns were
-- declared UUID because a name like `created_by` reads as a foreign key to a
-- table whose primary key happens to be one. Postgres rejects the write with
-- 22P02 `invalid input syntax for type uuid`, so the routes that write them
-- returned 500 to every caller — not intermittent, not a permission problem, the
-- feature simply never worked.
--
-- This is the host's share of a sweep that also touched seven extensions, and it
-- is deliberately one table.
--
-- `zv_pages.updated_by` looked like it belonged here too: the engine creates
-- `zv_pages` in 001_initial.sql and reads it for the sitemap. It does not. The
-- COLUMN is added by content/page-builder's own 001_initial.sql
-- (`ALTER TABLE zv_pages ADD COLUMN IF NOT EXISTS updated_by UUID`), so on a
-- database with no extensions it does not exist and this migration died on it —
-- `column "updated_by" of relation "zv_pages" does not exist`, engine refusing
-- to boot.
--
-- Ownership is per column, not per table: the host owns `zv_pages`, the
-- extension owns what it adds to it, and each repairs its own.
--
-- Found by pressing the button on a virgin database, which is the only place
-- this is visible: on an instance that has been in use, some of these columns
-- were altered by hand at some point. That is also why the earlier repair in
-- compliance/ro/documents (`003_user_ref_text.sql`) fixed exactly one column and
-- left its own siblings — somebody mended the instance in front of them rather
-- than the class.
--
-- Only columns that actually RECEIVE `user.id` are converted, established by
-- reading each INSERT/UPDATE against its bound values. `zv_rate_limit_configs.updated_by`
-- is deliberately left alone: it is a uuid with a matching name that NOTHING
-- writes, which is a different defect and not this one.
--
-- uuid → text needs no USING clause and preserves existing values.

ALTER TABLE IF EXISTS zv_edge_functions ALTER COLUMN created_by TYPE TEXT;

-- ── from 038_rate_limit_updated_by_text.sql ────────────────────────

-- The last uuid column named `*_by`, so the class can be checked rather than remembered.
--
-- `zv_rate_limit_configs.updated_by` is a uuid and `"user".id` is a 32-character
-- nanoid. Nothing writes it today, which is exactly why it survived two passes: a
-- column read and never written looks harmless. It is not. The first route that
-- records who changed a rate limit fails with 22P02, and whoever adds it spends
-- the afternoon on a cast error instead of on the feature.
--
-- Converted alongside five in the extensions repo, and the reason for doing the
-- whole class at once is the detector. The earlier sweep worked from a
-- hand-written list of column names — `created_by`, `approved_by`, `changed_by`
-- and so on — and missed `checked_by`, which is the column every tick on a
-- checklist writes. Ticking an item off had never worked on any installation,
-- and the list did not know to ask about it.
--
-- Ask the catalogue instead: which uuid columns are named `*_by`? With this
-- migration the answer is none, which is a property a test can assert without
-- anybody having to think of the name first.

ALTER TABLE IF EXISTS zv_rate_limit_configs ALTER COLUMN updated_by TYPE TEXT;

-- ── from 039_media_folders_updated_at.sql ──────────────────────────

-- `zv_media_folders` has no `updated_at`, and two extensions select one.
--
-- The table is declared in `001_initial.sql` with `created_at` only. Both
-- `storage/cloud` and `content/media` read `updated_at` from it — the folder
-- listing orders by it — so on a fresh install `GET /ext/storage/cloud/files`
-- answers 500 with `column "updated_at" does not exist`, and Postgres helpfully
-- suggests `created_at` in the hint.
--
-- Found by pressing the route on a virgin database. It cannot be seen on a
-- long-lived instance: somebody added the column by hand at some point, which is
-- also why nobody noticed the migration never had it.
--
-- Added here rather than in an extension migration because the table is the
-- engine's own declaration. Backfilled from `created_at` so existing rows have a
-- sensible value rather than NULL — a folder that has never been renamed was
-- last changed when it was made.

ALTER TABLE zv_media_folders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE zv_media_folders SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE zv_media_folders ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE zv_media_folders ALTER COLUMN updated_at SET NOT NULL;

-- ── from 040_api_key_rls_bypass_backfill.sql ───────────────────────

-- API keys created before migration 032 still bypass row-level security.
--
-- Migration 026 added the column as `NOT NULL DEFAULT true`, which wrote an
-- explicit `true` into every key that existed at the time and into every key
-- created afterwards. Migration 032 then changed the default to `false` — and
-- only the default. It contains no UPDATE, so every key created before it kept
-- its explicit `true`, and `NOT NULL` means there is no "unset" state to fall
-- back to. The result is that the security posture depends on the date a key
-- was issued, which is not a property anyone can see from the admin UI.
--
-- What such a key does: `rls.ts` returns an empty policy list for it, so the
-- key reads every tenant's rows regardless of the policies on the tables.
--
-- Only keys issued BEFORE 032 ran are reset. Keys issued after it had to pass
-- `rls_bypass: true` explicitly through `POST /api/api-keys`, and that is a
-- deliberate choice this migration has no business overturning. The cut-off is
-- read from the schema ledger rather than hardcoded, because the date differs
-- per install.
--
-- If the ledger has no record of 032 — a database migrated by some other route
-- — every bypassing key is reset. That direction is chosen on purpose: the
-- failure mode of resetting too many keys is an integration that returns fewer
-- rows and reports it, while the failure mode of resetting too few is silent
-- cross-tenant reads.
--
-- Restoring bypass on a key is deliberately not a one-click operation: there is
-- no PATCH for the field. Issue a replacement key with `rls_bypass: true`.

DO $backfill$
DECLARE
  cutoff  TIMESTAMPTZ;
  changed INTEGER;
BEGIN
  SELECT applied_at INTO cutoff
  FROM zv_schema_versions
  WHERE version = 32 AND rolled_back_at IS NULL
  ORDER BY applied_at DESC
  LIMIT 1;

  UPDATE zv_api_keys
  SET rls_bypass = false
  WHERE rls_bypass
    AND (cutoff IS NULL OR created_at < cutoff);

  GET DIAGNOSTICS changed = ROW_COUNT;

  IF changed > 0 THEN
    RAISE NOTICE
      '[040] % API key(s) no longer bypass row-level security. They were issued before the '
      'default changed and had been reading across every tenant. Re-issue with rls_bypass:true '
      'if an integration genuinely needs instance-wide reads.', changed;
  END IF;
END
$backfill$;

-- ── from 041_audit_metadata_object.sql ─────────────────────────────

-- Every audit log entry ever written stored its metadata as a JSON string, not
-- a JSON object.
--
-- `auditLog` interpolated `JSON.stringify(metadata)` and cast it `::jsonb`. The
-- driver already sends that parameter as jsonb, so the cast is a no-op and
-- Postgres stored the serialized text AS a jsonb string scalar: the whole
-- object wrapped in quotes, its own quotes escaped.
--
-- The consequence is not cosmetic. `metadata->>'outcome'` answers NULL on every
-- such row, and so does every other key. Nobody could filter the audit trail by
-- what happened, count failed attempts, or alert on a pattern — the log was
-- readable by a person scrolling it and queryable by no one. That is most of
-- what an audit trail is for, and it failed silently: the rows are there, they
-- look right, and the query returns nothing.
--
-- The write is fixed in lib/audit.ts (`::text::jsonb`). This repairs what is
-- already stored.
--
-- `#>> '{}'` extracts a jsonb scalar as text — the inverse of the mistake —
-- and the result is re-parsed. Guarded on `jsonb_typeof = 'string'` so it
-- touches only the damaged rows and can be re-run safely: rows already objects
-- are skipped, and rows repaired by an earlier run are objects.

UPDATE zv_audit_log
SET metadata = (metadata #>> '{}')::jsonb
WHERE jsonb_typeof(metadata) = 'string'
  -- A metadata value that is *legitimately* a string would be destroyed by
  -- re-parsing, so only touch what parses as an object. Nothing writes a bare
  -- string today, but this migration will outlive that assumption.
  AND (metadata #>> '{}') LIKE '{%';

-- ── from 042_flow_step_types_match_executor.sql ────────────────────

-- Four lists of flow step types, all different, none compared to another.
--
--   this CHECK constraint  : run_script, send_email, webhook, query_db,
--                            condition, transform, delay, send_notification,
--                            export_collection                        (9)
--   flow-executor's switch : query_db, run_script, send_email, webhook,
--                            send_notification, export_collection,
--                            ai_decision                              (7)
--   flow-step-schemas.ts   : twelve, of which eight never execute
--   the Studio's builder   : six, three of which never execute
--
-- Two consequences, in opposite directions:
--
--   `condition`, `transform` and `delay` are STORABLE and never execute. Until
--   now the executor's `default` arm returned the previous step's output and
--   reported success, so a flow built around a condition ran green and did
--   nothing — and its run history said it worked. That is fixed in the executor;
--   this stops new ones being created.
--
--   `ai_decision` is the reverse: the executor implements it and this CHECK
--   refuses to store it, so the feature could not be used at all.
--
-- The constraint now names exactly what `EXECUTABLE_STEP_TYPES` lists, which is
-- derived from the switch that runs. A unit test asserts those two stay equal.
--
-- NOT VALID on purpose. Existing rows carrying `condition`, `transform` or
-- `delay` are left alone: an install that has been running such a flow for
-- months should not have its migration fail, and those steps now fail loudly at
-- execution instead of silently succeeding — which is the outcome that matters.
-- New rows are checked from here on.

ALTER TABLE zv_flow_steps DROP CONSTRAINT IF EXISTS zv_flow_steps_type_check;

ALTER TABLE zv_flow_steps
  ADD CONSTRAINT zv_flow_steps_type_check
  CHECK (type IN (
    'query_db',
    'run_script',
    'send_email',
    'webhook',
    'send_notification',
    'export_collection',
    'ai_decision'
  ))
  NOT VALID;

-- ── from 043_worker_sql_role.sql ───────────────────────────────────

-- A database role for the worker SQL bridge — the sandbox for extension code
-- the platform has decided NOT to trust.
--
-- The bridge ran under `zveltio_rls`, and `ensureRlsEnforcementRole` grants that
-- role SELECT, INSERT, UPDATE and DELETE on EVERY table in `public`. Better-Auth
-- keeps `user`, `session`, `account`, `verification` and `twoFactor` there, none
-- of them with RLS. So a community extension could read live session tokens and
-- write itself an admin role, and the only thing between it and them was a
-- string check that had no rule for unprefixed tables at all.
--
-- The string check is now an allowlist (worker-sql-policy.ts). This is the
-- boundary underneath it: Postgres refuses regardless of what the query looked
-- like, or of a future gap in the parser. Same lesson migration 024 records for
-- flow `query_db` steps — the database enforces, the string check advises.
--
-- The grant is an ALLOWLIST, deliberately, in 024's words: "A denylist means
-- every future system table is readable until someone remembers to add it."
-- Collections (`zvd_*`) are what extensions exist to work with; everything else
-- is refused because it was never granted.
--
-- DML rather than SELECT: unlike a flow query step, a worker extension writes.
-- RLS still applies — the role is NOSUPERUSER and NOBYPASSRLS, so tenant
-- isolation on `zvd_*` holds exactly as it does for a request.
--
-- Best-effort, like 024: a managed Postgres where the application user cannot
-- CREATE ROLE must not fail the upgrade. When the role is absent the bridge
-- keeps its previous behaviour and the allowlist in worker-sql-policy.ts is the
-- only layer — which is why that layer was fixed first rather than instead.
DO $$
DECLARE
  t record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_worker') THEN
    CREATE ROLE zveltio_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- The connecting user must be a member to `SET ROLE` to it.
  EXECUTE format('GRANT zveltio_worker TO %I', current_user);

  GRANT USAGE ON SCHEMA public TO zveltio_worker;

  -- Collection tables only. New ones are granted at create time; see
  -- grantWorkerSqlAccess() beside grantFlowReaderSelect().
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'zvd\_%'
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO zveltio_worker', t.tablename);
  END LOOP;

  -- Sequences backing those tables, or every INSERT fails on the identity column.
  FOR t IN
    SELECT sequencename FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename LIKE 'zvd\_%'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO zveltio_worker', t.sequencename);
  END LOOP;

  -- Belt and braces, as 024 does: an explicit REVOKE on the tables this exists
  -- to protect, in case a future default-privilege change hands out blanket
  -- access. `twoFactor` is included — it was not in 024's list, and it holds the
  -- second-factor secrets.
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('session', 'user', 'account', 'verification', 'twoFactor')
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM zveltio_worker', t.tablename);
  END LOOP;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'zveltio_worker not created (insufficient privilege). The worker SQL bridge falls back to its previous role — see 043_worker_sql_role.sql.';
END
$$;

-- ── from 044_auth_tables_rls.sql ───────────────────────────────────

-- Row-level security on the four tables Better-Auth owns.
--
-- `user`, `session`, `account` and `verification` have had no RLS in any
-- migration. That is why C-14 and C-10 — two separate string guards that had no
-- rule for unprefixed table names — reached live session tokens and password
-- hashes across every tenant rather than one. Both guards are fixed; this is the
-- layer that makes the next miss survivable instead of total.
--
-- These tables have no `tenant_id`, so this is NOT tenant scoping. It is a
-- default of "no rows for anybody the policy does not name", which is the
-- correct posture for tables that hold credentials.
--
-- `user` is deliberately NOT in the list, and the reason is what it holds:
-- id, name, email, role, timestamps — no credentials. The password lives in
-- `account`, the bearer token in `session`. Meanwhile the engine's own features
-- read `user` constantly through the tenant-scoped handle: `/api/me`, the user
-- list, notification fan-out, the health probe. Enabling RLS there took
-- `/api/me` to a 500 — measured, not predicted — and the containment gained
-- would have been over the least sensitive of the five.
--
-- So the line is drawn at the credentials: `zveltio_rls` keeps SELECT on `user`
-- and nothing at all on the other four. Extensions get nothing on any of them
-- (migration 043 revokes all five from `zveltio_worker`), because an extension
-- has no business reading the user table either.
--
-- ENABLE, not FORCE, and that distinction is the whole design:
--
--   * RLS does not bind a table's OWNER unless FORCE is set. The engine connects
--     as the role that owns these tables, so Better-Auth's own reads and writes
--     during sign-in, sign-up and session refresh are untouched. Adding FORCE
--     here would lock the product out of its own authentication.
--   * Every other role — `zveltio_rls`, `zveltio_worker`, `zveltio_flow_reader`,
--     anything added later — IS bound, and with no permissive policy present it
--     sees zero rows.
--
-- No policy is created deliberately. A table with RLS enabled and no policy
-- returns nothing to a non-owner, which is exactly the intent; writing
-- `USING (false)` would say the same thing with more to go wrong.
--
-- The grants are the other half. `ensureRlsEnforcementRole` runs at every boot
-- and granted `zveltio_rls` full DML on every table in `public`, so a REVOKE
-- here would be undone by the next start — that loop now skips these five names.
-- The REVOKE below cleans up installs that already ran it.

DO $$
DECLARE
  t record;
  r record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('session', 'account', 'verification', 'twoFactor')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);

    -- Take back what the blanket grant handed out on earlier boots. Only roles
    -- this product creates: a REVOKE aimed at whatever else an operator has
    -- granted would be this migration guessing at their deployment.
    FOR r IN
      SELECT rolname FROM pg_roles
      WHERE rolname IN ('zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader')
    LOOP
      EXECUTE format('REVOKE ALL ON public.%I FROM %I', t.tablename, r.rolname);
    END LOOP;
  END LOOP;
END
$$;

-- ── from 045_api_key_empty_scopes_deny.sql ─────────────────────────

-- Make "full access" something an operator chose, not something they defaulted into.
--
-- `checkAccess` for an api_key principal reads:
--
--     if (scopes.length > 0) { ...enforce... }
--     return true;
--
-- so an EMPTY scope array skips enforcement entirely. The create route defaults
-- `scopes` to `[]`, and so does this column. `POST /api/api-keys {"name":"x"}`
-- therefore mints a key that can read, create, update and delete every `zvd_*`
-- collection in its tenant, forever — `expires_at` is optional too.
--
-- The comment in the code says so plainly ("Empty array = full access") and that
-- is the problem: to every human being who fills in a form, "no permissions
-- selected" means "cannot do anything". Here it meant the opposite, and the
-- operator most likely to leave the field blank is the one aiming for least
-- privilege.
--
-- The code now treats `[]` as deny-all. That flip would silently break every key
-- already issued this way, so this migration writes down what those keys can do
-- TODAY, explicitly, before the meaning of the empty array changes. Nothing
-- gains a permission it did not already have; the grant simply stops being
-- implicit.
--
-- After this, `[]` means what it looks like, and a full-access key has to say
-- `[{"collection":"*","actions":["*"]}]` out loud.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE zv_api_keys
    SET scopes = '[{"collection":"*","actions":["*"]}]'::jsonb
    WHERE scopes IS NULL
       OR jsonb_typeof(scopes) <> 'array'
       OR jsonb_array_length(scopes) = 0;
  GET DIAGNOSTICS n = ROW_COUNT;

  IF n > 0 THEN
    RAISE WARNING '[api-keys] % key(s) had no scopes and therefore full access to every collection. Their access is now written down explicitly — review them at /admin/api-keys and narrow any that should not be tenant-wide.', n;
  END IF;
END
$$;

-- New keys default to no access rather than all access. A key with an empty
-- scope list is refused by `checkAccess`, which is what the empty list looks
-- like it means.
ALTER TABLE zv_api_keys ALTER COLUMN scopes SET DEFAULT '[]'::jsonb;

-- ── from 046_two_factor_verified.sql ───────────────────────────────

-- The column that made two-factor authentication impossible to switch on.
--
-- Found while fixing the backup-code storage, by trying to enable 2FA:
--
--   POST /api/auth/two-factor/enable → 500
--   PostgresError: column "verified" of relation "twoFactor" does not exist
--
-- Better-Auth writes `verified` when a user enables 2FA
-- (`plugins/two-factor/index.mjs:126`) and reads it when listing a user's
-- available methods (`:264`). `001_initial.sql` created the table with
-- `id, secret, backupCodes, userId` and nothing else, so the INSERT has always
-- failed. Two-factor authentication is on the feature list, is wired into the
-- auth plugin set, and could not be turned on by anybody.
--
-- Nothing caught it because the write comes from inside the auth library rather
-- than from a statement in this repository, so the seam gate — which reads the
-- SQL this codebase writes — had nothing to look at. The only way to find it was
-- to enable 2FA and watch.
--
-- Default TRUE, not FALSE. An existing row can only have been written by an
-- older Better-Auth that had no such column, which means it was created under a
-- version that treated the factor as usable once stored; reading those rows as
-- unverified would silently disable 2FA for anyone who has it today. New rows
-- get their value from the library on the way in.

ALTER TABLE "twoFactor" ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT TRUE;

-- And the two that implement lockout, which the same schema declares:
-- `failedVerificationCount` is incremented on every wrong code and `lockedUntil`
-- is set once it passes the limit (`verify-two-factor.mjs:138,160`). Without
-- them there is no rate limit on guessing a six-digit TOTP code at all, so
-- adding `verified` alone would have made 2FA switchable on and left it
-- brute-forceable. Found by enabling it again after the first column landed and
-- reading the next error.
ALTER TABLE "twoFactor" ADD COLUMN IF NOT EXISTS "failedVerificationCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "twoFactor" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMPTZ;

-- ── from 047_fail_closed_tenant_opt_in.sql ─────────────────────────

-- 047_fail_closed_tenant_opt_in.sql
--
-- Opt-in fail-closed tenant visibility when the current_tenant GUC is unset.
--
-- Default (flag off): GUC unset → match the default tenant (029 semantics).
-- With zveltio.fail_closed_tenant = 'on': GUC unset → no rows (true fail-closed).
--
-- Operators enable via env ZVELTIO_FAIL_CLOSED_TENANT=1 at boot (engine sets the
-- database GUC). Do not flip this on by default — single-tenant installs and
-- contextless jobs (migrations, GC) rely on the 029 fallback until they all set
-- an explicit tenant or use a privileged system role.

CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      false
    ELSE
      row_tenant = '00000000-0000-0000-0000-000000000001'::uuid
  END
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_scope_ok(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      false
    ELSE
      row_tenant = '00000000-0000-0000-0000-000000000001'
  END
$$;

COMMENT ON FUNCTION zveltio_tenant_scope_ok(uuid) IS
  'Tenant row visibility. When zveltio.fail_closed_tenant=on and current_tenant '
  'is unset, returns false (no rows). Otherwise matches 029 default-tenant fallback. '
  'See migration 047 + ZVELTIO_FAIL_CLOSED_TENANT.';

COMMENT ON FUNCTION zveltio_tenant_scope_ok(text) IS
  'TEXT overload of zveltio_tenant_scope_ok(uuid). Same fail-closed opt-in. See 047.';

-- ── from 048_import_logs_extension_owned.sql ───────────────────────

-- 048_import_logs_extension_owned.sql
--
-- `zv_import_logs` was created twice with two vocabularies: by the engine in
-- 001 (`file_format`, `success_rows`, `error_rows`, status `processing`) and by
-- the `data/import` extension (`format`, `imported_rows`, `failed_rows`, status
-- `running`). The engine's `/api/import` route is gone, so the extension is now
-- the table's only writer and its vocabulary is the one that should survive.
--
-- This is the EXPAND half only: add the extension's columns where they are
-- missing and carry the engine-era data across. The CONTRACT half — dropping
-- `file_format`, `processed_rows`, `success_rows`, `error_rows` and `options` —
-- is NOT a later migration. It is `contractImportLogs`
-- (lib/data/import-logs-contract.ts), a boot reconciler an operator arms with
-- ZVELTIO_IMPORT_LOGS_CONTRACT=1.
--
-- Not a migration because a migration runs once and is then recorded as
-- applied, and the moment this may safely run is not the moment it would
-- execute: it is whenever a given deployment's rollout has finished, which no
-- SQL can detect and which differs per operator.
--
-- Why the wait: during a rolling upgrade an instance still running the previous
-- engine serves `/api/import` and both reads those columns and writes status
-- `processing`. Dropping them in the same release that deletes the route breaks
-- that instance for the length of the rollout. Every dead column is
-- `NOT NULL DEFAULT`, so leaving them costs the extension nothing — its inserts
-- never mention them and the defaults fill them in.

-- No-op on the extension's own shape; fills in the engine-shaped table.
ALTER TABLE zv_import_logs
  ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'csv',
  ADD COLUMN IF NOT EXISTS failed_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imported_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS errors JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS filename TEXT;

-- Backfill from the engine vocabulary, guarded so this also runs on a database
-- that only ever had the extension's shape.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'zv_import_logs' AND column_name = 'file_format'
  ) THEN
    EXECUTE $q$
      UPDATE zv_import_logs
      SET format = file_format
      WHERE (format IS NULL OR format = 'csv')
        AND file_format IS NOT NULL
        AND file_format <> ''
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'zv_import_logs' AND column_name = 'error_rows'
  ) THEN
    EXECUTE $q$
      UPDATE zv_import_logs
      SET failed_rows = error_rows
      WHERE failed_rows = 0 AND error_rows IS NOT NULL AND error_rows <> 0
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'zv_import_logs' AND column_name = 'success_rows'
  ) THEN
    EXECUTE $q$
      UPDATE zv_import_logs
      SET imported_rows = success_rows
      WHERE imported_rows = 0 AND success_rows IS NOT NULL AND success_rows <> 0
    $q$;
  END IF;
END $$;

-- `format` lost its CHECK along the way: the extension declared the union in
-- its 001, then re-added the column without it in 003_engine_shaped_table, and
-- ADD COLUMN IF NOT EXISTS above inherits that weaker shape. Restoring it means
-- the column carries the same meaning on a virgin install and an upgrade, and
-- schema-codegen emits the union rather than a bare string.
--
-- NOT VALID on purpose, and not only to keep the lock short: the backfill above
-- copies `file_format`, whose vocabulary included `xlsx`. Validating would force
-- a choice between failing the migration and rewriting those rows to 'csv',
-- and 'csv' would be a lie about what was imported. NOT VALID constrains every
-- future write — the only writer left is the extension, which never emits
-- `xlsx` — while leaving historical rows to say what actually happened.
ALTER TABLE zv_import_logs DROP CONSTRAINT IF EXISTS zv_import_logs_format_check;
ALTER TABLE zv_import_logs
  ADD CONSTRAINT zv_import_logs_format_check
  CHECK (format IN ('csv', 'json', 'ndjson')) NOT VALID;

-- ── from 049_edge_functions_rls.sql ────────────────────────────────

-- 049_edge_functions_rls.sql
--
-- Row-level security for zv_edge_functions and zv_edge_function_logs.
--
-- Migration 015 gave both tables a `tenant_id`, a GUC-backed DEFAULT and a
-- per-tenant UNIQUE, and closed the cross-tenant IDOR it describes — but it
-- closed it in the HANDLERS, and said so: "they run on the request db without
-- relying on RLS". No policy was ever created; verified on a freshly migrated
-- database, where both tables report relrowsecurity = false and zero policies.
--
-- That worked while the handlers were the engine's. Edge-function CRUD now
-- belongs to extensions/developer/edge-functions, and the extension's routes
-- scope by `id`, `path` and `is_active` — never by tenant. Its own comment
-- explains why: "`db` is `ctx.db` … already RLS-scoped — there is one spelling,
-- so there is none to forget." That is true of every other table it could have
-- been written against, and false of exactly these two.
--
-- So the isolation was carried by the copy that moved out, and the assumption
-- that replaced it does not hold here: an admin of one tenant could list, read,
-- patch, delete and INVOKE another tenant's functions — which store secrets in
-- `env_vars` and run arbitrary code — and read their invocation logs.
--
-- Fixed at the database rather than by restoring predicates route by route.
-- Predicates protect the routes someone remembers to write them in, and the bug
-- being fixed is a route that did not. A policy protects the next one too, and
-- it makes the extension's assumption true instead of nearly true.

-- FORCE matters: without it Postgres lets the table owner bypass the policy,
-- and the engine connects as owner on a stock install, so RLS would be
-- advisory. Requests run as the non-bypassing `zveltio_rls` role.
ALTER TABLE zv_edge_functions ENABLE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_functions FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_function_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_function_logs FORCE ROW LEVEL SECURITY;

-- The host's own predicate, matching the column DEFAULT migration 015 already
-- set, so reads and writes cannot disagree. Named `tenant_isolation_*` so the
-- boot reconciler adopts them like every other extension-owned table.
DROP POLICY IF EXISTS tenant_isolation_zv_edge_functions ON zv_edge_functions;
CREATE POLICY tenant_isolation_zv_edge_functions ON zv_edge_functions
  USING (zveltio_tenant_scope_ok(tenant_id))
  WITH CHECK (zveltio_tenant_scope_ok(tenant_id));

DROP POLICY IF EXISTS tenant_isolation_zv_edge_function_logs ON zv_edge_function_logs;
CREATE POLICY tenant_isolation_zv_edge_function_logs ON zv_edge_function_logs
  USING (zveltio_tenant_scope_ok(tenant_id))
  WITH CHECK (zveltio_tenant_scope_ok(tenant_id));

-- Rows written before 015 backfilled, and any written since by a path with no
-- tenant context, would become invisible to everyone rather than visible to
-- everyone. 015 already backfilled; this is the guard for anything after it.
UPDATE zv_edge_functions SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;
UPDATE zv_edge_function_logs SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE tenant_id IS NULL;

-- Deliberately NOT `SET NOT NULL`. It would block reads for the length of a
-- table scan — `zv_edge_function_logs` is the one table here that grows without
-- bound — and it buys nothing: `zveltio_tenant_scope_ok(NULL)` is NULL, so the
-- policy already hides a NULL-tenant row from everyone rather than showing it
-- to everyone, and the DEFAULT above stops new ones appearing.

-- DOWN

-- ── from 049_edge_functions_rls.sql ────────────────────────────────

DROP POLICY IF EXISTS tenant_isolation_zv_edge_functions ON zv_edge_functions;
DROP POLICY IF EXISTS tenant_isolation_zv_edge_function_logs ON zv_edge_function_logs;
ALTER TABLE zv_edge_functions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_functions DISABLE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_function_logs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE zv_edge_function_logs DISABLE ROW LEVEL SECURITY;

-- ── from 048_import_logs_extension_owned.sql ───────────────────────

ALTER TABLE zv_import_logs DROP CONSTRAINT IF EXISTS zv_import_logs_format_check;

-- ── from 046_two_factor_verified.sql ───────────────────────────────

ALTER TABLE "twoFactor" DROP COLUMN IF EXISTS verified;
ALTER TABLE "twoFactor" DROP COLUMN IF EXISTS "failedVerificationCount";
ALTER TABLE "twoFactor" DROP COLUMN IF EXISTS "lockedUntil";

-- ── from 045_api_key_empty_scopes_deny.sql ─────────────────────────

-- Deliberately not reversed. Undoing it would mean deleting the explicit
-- wildcard scopes, which under the OLD code meant full access and under the new
-- code means none — so a rollback that "restored" `[]` would lock out every key
-- this migration touched. The explicit form is correct under both.

-- ── from 044_auth_tables_rls.sql ───────────────────────────────────

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('session', 'account', 'verification', 'twoFactor')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$$;

-- ── from 043_worker_sql_role.sql ───────────────────────────────────

DROP ROLE IF EXISTS zveltio_worker;

-- ── from 042_flow_step_types_match_executor.sql ────────────────────

ALTER TABLE zv_flow_steps DROP CONSTRAINT IF EXISTS zv_flow_steps_type_check;
ALTER TABLE zv_flow_steps
  ADD CONSTRAINT zv_flow_steps_type_check
  CHECK (type IN (
    'run_script', 'send_email', 'webhook', 'query_db', 'condition',
    'transform', 'delay', 'send_notification', 'export_collection'
  ))
  NOT VALID;

-- ── from 041_audit_metadata_object.sql ─────────────────────────────

-- Not reversible, and should not be. Reverting would mean re-breaking the
-- column, and any row written after this migration is a genuine object that
-- would be indistinguishable from a repaired one.

-- ── from 040_api_key_rls_bypass_backfill.sql ───────────────────────

-- Not reversible. The column cannot distinguish a key this migration reset from
-- one that was always false, and restoring cross-tenant reads to a set of keys
-- guessed by date is worse than leaving them scoped.

-- ── from 001_initial.sql ───────────────────────────────────────────

-- ── DOWN from 075_electric_replication.sql ──
DROP FUNCTION IF EXISTS zv_electric_disable_table(TEXT);
DROP FUNCTION IF EXISTS zv_electric_enable_table(TEXT);
DROP PUBLICATION IF EXISTS zveltio_electric;

-- ── DOWN from 074_drop_legacy_ddl_jobs.sql ──
-- Recreate the schema as it existed in migration 014_ddl_retry.sql.
-- We don't restore data — if a rollback is needed, run the pre-074
-- backup and lose only the jobs written since 074 applied (which is
-- always zero, since nothing writes to this table after wave 32).
CREATE TABLE IF NOT EXISTS zv_ddl_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error         TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  max_retries   INTEGER NOT NULL DEFAULT 3,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zv_ddl_jobs_status ON zv_ddl_jobs(status);

-- ── DOWN from 073_license_audit.sql ──
DROP INDEX IF EXISTS idx_zv_license_audit_extension;
DROP INDEX IF EXISTS idx_zv_license_audit_performed_at;
DROP TABLE IF EXISTS zv_license_audit;

-- ── DOWN from 072_extension_schedule_runs.sql ──
DROP INDEX IF EXISTS idx_zv_ext_schedule_runs_status;
DROP INDEX IF EXISTS idx_zv_ext_schedule_runs_ext_sched;
DROP TABLE IF EXISTS zv_extension_schedule_runs;

-- ── DOWN from 071_zv_migrations_down_sql.sql ──
ALTER TABLE zv_migrations DROP COLUMN IF EXISTS down_sql;

-- ── DOWN from 066_schema_branches_approval_gates.sql ──
ALTER TABLE zv_schema_branches DROP COLUMN IF EXISTS requires_approval;

-- ── DOWN from 065_schema_branches_preview_token_expiry.sql ──
DROP INDEX IF EXISTS idx_branches_preview_expires;
ALTER TABLE zv_schema_branches
  DROP COLUMN IF EXISTS preview_expires_at,
  DROP COLUMN IF EXISTS preview_token_rotated_at;

-- ── DOWN from 058_performance_indexes.sql ──
DROP INDEX IF EXISTS idx_revisions_record_id;
DROP INDEX IF EXISTS idx_audit_log_user_time;
DROP INDEX IF EXISTS idx_flows_active_trigger;
DROP INDEX IF EXISTS idx_permissions_resource_action;
DROP INDEX IF EXISTS idx_api_keys_created_by;
DROP INDEX IF EXISTS idx_edge_fn_logs_time;
DROP INDEX IF EXISTS idx_request_logs_path_status;

-- ── DOWN from 057_rate_limit_configs.sql ──
DROP INDEX IF EXISTS idx_rate_limit_configs_active;
DROP TABLE IF EXISTS zv_rate_limit_configs;

-- ── DOWN from 052_role_cleanup.sql ──
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_role_check;
ALTER TABLE "user" ADD CONSTRAINT user_role_check
  CHECK (role IN ('god', 'admin', 'manager', 'member'));

-- ── DOWN from 051_fix_client_zone_base_path.sql ──
-- UPDATE zvd_zones SET base_path = '/portal/client' WHERE slug = 'client' AND base_path = '/portal-client';

-- ── DOWN from 050_zones_pages_views.sql ──
-- DROP TABLE IF EXISTS zvd_page_views;
-- DROP TABLE IF EXISTS zvd_pages;
-- DROP TABLE IF EXISTS zvd_zones;
-- DROP TABLE IF EXISTS zvd_views;

-- ── DOWN from 047_encrypted_fields.sql ──
-- DROP VIEW IF EXISTS zv_encrypted_fields;

-- ── DOWN from 046_slow_queries.sql ──
-- DROP INDEX IF EXISTS idx_slow_queries_created;
-- DROP INDEX IF EXISTS idx_slow_queries_path;
-- DROP INDEX IF EXISTS idx_slow_queries_duration;
-- DROP TABLE IF EXISTS zv_slow_queries;

-- ── DOWN from 044_user_auth_v15.sql ──
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_role_check;
ALTER TABLE "user" ADD CONSTRAINT user_role_check
  CHECK (role IN ('admin', 'manager', 'member'));
ALTER TABLE "user" DROP COLUMN IF EXISTS "twoFactorEnabled";

-- ── DOWN from 041_revisions_index.sql ──
DROP INDEX IF EXISTS idx_zv_revisions_lookup;

-- ── DOWN from 040_edge_functions.sql ──
DROP INDEX IF EXISTS idx_fn_logs_function;
DROP TABLE IF EXISTS zv_edge_function_logs;
DROP TABLE IF EXISTS zv_edge_functions;

-- ── DOWN from 038_protected_api.sql ──
DROP INDEX IF EXISTS idx_api_key_access_log_created;
DROP INDEX IF EXISTS idx_api_key_access_log_key;
DROP TABLE IF EXISTS zv_api_key_access_log;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS last_ip;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS request_count;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS casbin_subject;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS permissions_mode;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS description;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS organization;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS allowed_ips;

-- ── DOWN from 037_cloud_storage.sql ──
DROP TABLE IF EXISTS zv_storage_quotas;
DROP INDEX IF EXISTS idx_media_shares_folder;
DROP INDEX IF EXISTS idx_media_shares_file;
DROP INDEX IF EXISTS idx_media_shares_token;
DROP TABLE IF EXISTS zv_media_shares;
ALTER TABLE zv_media_folders DROP COLUMN IF EXISTS deleted_at;
DROP INDEX IF EXISTS idx_media_files_deleted;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS restore_folder_id;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS deleted_by;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS deleted_at;
DROP INDEX IF EXISTS idx_media_versions_file;
DROP TABLE IF EXISTS zv_media_versions;

-- ── DOWN from 035_pitr.sql ──
DROP INDEX IF EXISTS idx_pitr_restore_points_at;
DROP TABLE IF EXISTS zv_pitr_restore_points;
DROP TABLE IF EXISTS zv_pitr_config;

-- ── DOWN from 031_byod_is_managed.sql ──
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS schema_locked;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS is_system;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS source_type;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS is_managed;

-- ── DOWN from 029_schema_branches.sql ──
DROP INDEX IF EXISTS idx_schema_branches_created;
DROP INDEX IF EXISTS idx_schema_branches_status;
DROP TABLE IF EXISTS zv_schema_branches;

-- ── DOWN from 028_documents.sql ──
DROP INDEX IF EXISTS idx_generated_docs_source;
DROP INDEX IF EXISTS idx_generated_docs_template;
DROP INDEX IF EXISTS idx_doc_templates_type;
DROP TABLE IF EXISTS zv_doc_templates;

-- ── DOWN from 027_document_templates.sql ──
DROP INDEX IF EXISTS idx_doc_generations_user;
DROP INDEX IF EXISTS idx_doc_generations_template;
-- ── DOWN from 026_insights.sql ──
DROP INDEX IF EXISTS idx_panels_dashboard;
DROP TABLE IF EXISTS zv_panels;
DROP TABLE IF EXISTS zv_dashboards;

-- ── DOWN from 025_quality.sql ──
DROP INDEX IF EXISTS idx_quality_issues_active;
DROP INDEX IF EXISTS idx_quality_issues_scan;
DROP TABLE IF EXISTS zv_quality_issues;
DROP INDEX IF EXISTS idx_quality_scans_collection;
DROP TABLE IF EXISTS zv_quality_scans;

-- ── DOWN from 024_validation_rules.sql ──
DROP INDEX IF EXISTS idx_validation_rules_active;
DROP INDEX IF EXISTS idx_validation_rules_collection;
DROP TABLE IF EXISTS zv_validation_rules;

-- ── DOWN from 023_saved_queries.sql ──
DROP INDEX IF EXISTS idx_saved_queries_shared;
DROP INDEX IF EXISTS idx_saved_queries_collection;
DROP INDEX IF EXISTS idx_saved_queries_user;
DROP TABLE IF EXISTS zv_saved_queries;

-- ── DOWN from 022_drafts.sql ──
DROP INDEX IF EXISTS idx_publish_schedule;
DROP INDEX IF EXISTS idx_drafts_created_by;
DROP INDEX IF EXISTS idx_drafts_status;
DROP INDEX IF EXISTS idx_drafts_collection;
-- ── DOWN from 021_approvals.sql ──
DROP INDEX IF EXISTS idx_approval_decisions_request;
DROP INDEX IF EXISTS idx_approval_requests_by;
DROP INDEX IF EXISTS idx_approval_requests_status;
DROP INDEX IF EXISTS idx_approval_requests_collection;
DROP INDEX IF EXISTS idx_approval_steps_workflow;
DROP INDEX IF EXISTS idx_approval_workflows_collection;
-- ── DOWN from 020_pages.sql ──
DROP INDEX IF EXISTS idx_zv_form_submissions_status;
DROP INDEX IF EXISTS idx_zv_form_submissions_section;
DROP INDEX IF EXISTS idx_zv_form_submissions_page;
DROP INDEX IF EXISTS idx_zv_page_sections_type;
DROP INDEX IF EXISTS idx_zv_page_sections_page;
DROP INDEX IF EXISTS idx_zv_pages_active;
DROP INDEX IF EXISTS idx_zv_pages_homepage;
DROP INDEX IF EXISTS idx_zv_pages_slug;
-- ── DOWN from 019_backups.sql ──
DROP INDEX IF EXISTS idx_zv_backups_created_at;
DROP INDEX IF EXISTS idx_zv_backups_status;
DROP TABLE IF EXISTS zv_backups;

-- ── DOWN from 018_media.sql ──
DROP INDEX IF EXISTS idx_zv_media_file_tags_tag;
DROP INDEX IF EXISTS idx_zv_media_file_tags_file;
DROP TABLE IF EXISTS zv_media_file_tags;
DROP TABLE IF EXISTS zv_media_tags;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS duration_seconds;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS thumbnail_url;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS alt_text;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS description;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS title;

-- ── DOWN from 017_flows.sql ──
DROP INDEX IF EXISTS idx_zv_flow_runs_flow;
DROP TABLE IF EXISTS zv_flow_runs;
DROP INDEX IF EXISTS idx_zv_flow_steps_flow;
DROP TABLE IF EXISTS zv_flow_steps;
DROP INDEX IF EXISTS idx_zv_flows_active;
DROP TABLE IF EXISTS zv_flows;

-- ── DOWN from 016_multitenancy.sql ──
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

-- ── DOWN from 015_virtual_collections.sql ──
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS virtual_config;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS source_type;

-- ── DOWN from 014_ddl_retry.sql ──
ALTER TABLE zv_ddl_jobs DROP COLUMN IF EXISTS max_retries;
ALTER TABLE zv_ddl_jobs DROP COLUMN IF EXISTS retry_count;

-- ── DOWN from 013_extension_registry.sql ──
DROP TABLE IF EXISTS zv_extension_registry;

-- ── DOWN from 012_record_comments.sql ──
DROP INDEX IF EXISTS idx_zv_record_comments_user;
DROP INDEX IF EXISTS idx_zv_record_comments_record;
DROP TABLE IF EXISTS zv_record_comments;

-- ── DOWN from 010_import_logs.sql ──
DROP INDEX IF EXISTS idx_zv_import_logs_created;
DROP INDEX IF EXISTS idx_zv_import_logs_status;
DROP INDEX IF EXISTS idx_zv_import_logs_collection;
DROP TABLE IF EXISTS zv_import_logs;

DROP INDEX IF EXISTS idx_zvd_translations_locale;
DROP INDEX IF EXISTS idx_zvd_translations_key_locale;
DROP INDEX IF EXISTS idx_zvd_translation_keys_context;
DROP INDEX IF EXISTS idx_zvd_translation_keys_key;
-- ── DOWN from 008_api_keys.sql ──
DROP INDEX IF EXISTS idx_api_keys_active;
DROP INDEX IF EXISTS idx_api_keys_prefix;
DROP INDEX IF EXISTS idx_api_keys_user;
DROP INDEX IF EXISTS idx_api_keys_hash;
DROP TABLE IF EXISTS zv_api_keys;

-- ── DOWN from 007_notifications.sql ──
DROP INDEX IF EXISTS idx_push_subscriptions_user;
DROP TABLE IF EXISTS zv_push_subscriptions;
DROP INDEX IF EXISTS idx_notifications_user;
DROP TABLE IF EXISTS zv_notifications;

-- ── DOWN from 006_webhooks.sql ──
DROP INDEX IF EXISTS idx_zvd_webhook_deliveries_created;
DROP INDEX IF EXISTS idx_zvd_webhook_deliveries_webhook;
DROP TABLE IF EXISTS zvd_webhook_deliveries;
DROP INDEX IF EXISTS idx_zvd_webhooks_active;
DROP TABLE IF EXISTS zvd_webhooks;

-- ── DOWN from 005_storage.sql ──
DROP INDEX IF EXISTS idx_zv_media_files_created;
DROP INDEX IF EXISTS idx_zv_media_files_mimetype;
DROP INDEX IF EXISTS idx_zv_media_files_folder;
DROP TABLE IF EXISTS zv_media_files;
DROP INDEX IF EXISTS idx_zv_media_folders_parent;
DROP TABLE IF EXISTS zv_media_folders;

-- ── DOWN from 004_audit.sql ──
DROP INDEX IF EXISTS idx_zv_revisions_created;
DROP INDEX IF EXISTS idx_zv_revisions_user;
DROP INDEX IF EXISTS idx_zv_revisions_record;
DROP TABLE IF EXISTS zv_revisions;

-- ── DOWN from 003_settings.sql ──
DROP TABLE IF EXISTS zv_settings;

-- ── DOWN from 002_collections.sql ──
DROP INDEX IF EXISTS idx_zv_ddl_jobs_status;
DROP INDEX IF EXISTS idx_zvd_permissions_v0;
DROP INDEX IF EXISTS idx_zvd_permissions_ptype;
DROP INDEX IF EXISTS idx_zvd_relations_target;
DROP INDEX IF EXISTS idx_zvd_relations_source;
DROP TABLE IF EXISTS zv_ddl_jobs;
DROP TABLE IF EXISTS zvd_permissions;
DROP TABLE IF EXISTS zvd_relations;
DROP TABLE IF EXISTS zvd_collections;

-- ── DOWN from 001_auth.sql ──
DROP INDEX IF EXISTS idx_session_token;
DROP INDEX IF EXISTS idx_user_email;
DROP INDEX IF EXISTS idx_account_userId;
DROP INDEX IF EXISTS idx_session_userId;
DROP TABLE IF EXISTS "twoFactor";
DROP TABLE IF EXISTS verification;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS "user";

-- ── DOWN from 000_schema_versions.sql ──
DROP INDEX IF EXISTS idx_zv_schema_versions_version;
DROP TABLE IF EXISTS zv_schema_versions;
DROP TABLE IF EXISTS zv_migrations;
