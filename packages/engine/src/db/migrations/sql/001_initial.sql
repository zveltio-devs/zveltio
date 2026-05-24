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

-- Immutable audit log (security)
CREATE TABLE IF NOT EXISTS zvd_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'read', 'update', 'delete')),
  old_data JSONB,
  new_data JSONB,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_audit_log_table ON zvd_audit_log(table_name);
CREATE INDEX IF NOT EXISTS idx_zvd_audit_log_record ON zvd_audit_log(record_id);
CREATE INDEX IF NOT EXISTS idx_zvd_audit_log_created ON zvd_audit_log(created_at DESC);

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

-- ── from 009_translations.sql ──
-- Migration 009: Internationalization (i18n) translations

-- Translation keys registry
CREATE TABLE IF NOT EXISTS zvd_translation_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  context TEXT,                -- e.g. 'ui', 'content', 'email'
  default_value TEXT,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_translation_keys_key ON zvd_translation_keys(key);
CREATE INDEX IF NOT EXISTS idx_zvd_translation_keys_context ON zvd_translation_keys(context);

-- Translations (key + locale → value)
CREATE TABLE IF NOT EXISTS zvd_translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id UUID NOT NULL REFERENCES zvd_translation_keys(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  value TEXT NOT NULL,
  is_machine_translated BOOLEAN NOT NULL DEFAULT false,
  reviewed BOOLEAN NOT NULL DEFAULT false,
  updated_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(key_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_zvd_translations_key_locale ON zvd_translations(key_id, locale);
CREATE INDEX IF NOT EXISTS idx_zvd_translations_locale ON zvd_translations(locale);

-- Supported locales
CREATE TABLE IF NOT EXISTS zvd_locales (
  code TEXT PRIMARY KEY,         -- e.g. 'en', 'ro', 'de'
  name TEXT NOT NULL,            -- e.g. 'English', 'Română'
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default locales
INSERT INTO zvd_locales (code, name, is_default, is_active) VALUES
  ('en', 'English', true, true),
  ('ro', 'Română', false, true)
ON CONFLICT (code) DO NOTHING;

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

-- ── from 020_pages.sql ──
-- Migration: 020_pages
-- CMS Pages, page sections, and form submissions

CREATE TABLE IF NOT EXISTS zv_pages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  description      TEXT,
  meta_title       TEXT,
  meta_description TEXT,
  og_image         TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  is_homepage      BOOLEAN NOT NULL DEFAULT false,
  layout           TEXT NOT NULL DEFAULT 'default'
                     CHECK (layout IN ('default', 'full-width', 'sidebar-left', 'sidebar-right')),
  created_by       TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_zv_pages_slug     ON zv_pages(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_zv_pages_homepage ON zv_pages(is_homepage) WHERE is_homepage = true;
CREATE INDEX IF NOT EXISTS idx_zv_pages_active          ON zv_pages(is_active);

CREATE TABLE IF NOT EXISTS zv_page_sections (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id        UUID NOT NULL REFERENCES zv_pages(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL
                   CHECK (type IN ('hero', 'grid', 'list', 'carousel', 'text', 'html', 'map', 'form', 'stats', 'banner', 'cta', 'divider')),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  is_visible     BOOLEAN NOT NULL DEFAULT true,
  collection     TEXT,
  filter_config  JSONB NOT NULL DEFAULT '{}',
  sort_config    JSONB NOT NULL DEFAULT '[]',
  limit_count    INTEGER NOT NULL DEFAULT 10,
  fields         TEXT[] NOT NULL DEFAULT '{}',
  slug_field     TEXT,
  static_content JSONB NOT NULL DEFAULT '{}',
  style_config   JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_page_sections_page ON zv_page_sections(page_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_zv_page_sections_type ON zv_page_sections(type);

CREATE TABLE IF NOT EXISTS zv_form_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID NOT NULL REFERENCES zv_pages(id) ON DELETE CASCADE,
  section_id      UUID NOT NULL REFERENCES zv_page_sections(id) ON DELETE CASCADE,
  data            JSONB NOT NULL DEFAULT '{}',
  submitter_ip    TEXT,
  submitter_email TEXT,
  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'read', 'replied', 'spam')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_form_submissions_page    ON zv_form_submissions(page_id);
CREATE INDEX IF NOT EXISTS idx_zv_form_submissions_section ON zv_form_submissions(section_id);
CREATE INDEX IF NOT EXISTS idx_zv_form_submissions_status  ON zv_form_submissions(status);

-- ── from 021_approvals.sql ──
-- Migration: 021_approvals
-- Approval Workflows system

CREATE TABLE IF NOT EXISTS zv_approval_workflows (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT    NOT NULL,
  description TEXT,
  collection  TEXT    NOT NULL,
  trigger_field TEXT,
  trigger_value TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_approval_steps (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID    NOT NULL REFERENCES zv_approval_workflows(id) ON DELETE CASCADE,
  step_order      INT     NOT NULL DEFAULT 0,
  name            TEXT    NOT NULL,
  approver_role   TEXT,
  approver_user_id TEXT   REFERENCES "user"(id) ON DELETE SET NULL,
  deadline_hours  INT,
  is_required     BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_approval_requests (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id      UUID    NOT NULL REFERENCES zv_approval_workflows(id),
  collection       TEXT    NOT NULL,
  record_id        TEXT    NOT NULL,
  current_step_id  UUID    REFERENCES zv_approval_steps(id) ON DELETE SET NULL,
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by     TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  metadata         JSONB   NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS zv_approval_decisions (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID    NOT NULL REFERENCES zv_approval_requests(id) ON DELETE CASCADE,
  step_id     UUID    NOT NULL REFERENCES zv_approval_steps(id),
  decision    TEXT    NOT NULL CHECK (decision IN ('approved','rejected','skipped')),
  decided_by  TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  comment     TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_workflows_collection ON zv_approval_workflows(collection);
CREATE INDEX IF NOT EXISTS idx_approval_steps_workflow       ON zv_approval_steps(workflow_id, step_order);
CREATE INDEX IF NOT EXISTS idx_approval_requests_collection  ON zv_approval_requests(collection, record_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status      ON zv_approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_by          ON zv_approval_requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_request    ON zv_approval_decisions(request_id);

-- ── from 022_drafts.sql ──
-- Migration: 022_drafts
-- Content drafts and publish scheduling

CREATE TABLE IF NOT EXISTS zv_content_drafts (
  id           UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  collection   TEXT   NOT NULL,
  record_id    TEXT   NOT NULL,
  draft_data   JSONB  NOT NULL DEFAULT '{}',
  base_version INT    NOT NULL DEFAULT 1,
  status       TEXT   NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','review','approved','rejected')),
  notes        TEXT,
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_by   TEXT   REFERENCES "user"(id) ON DELETE SET NULL,
  reviewed_by  TEXT   REFERENCES "user"(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_collection_publish_settings (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  collection      TEXT    NOT NULL UNIQUE,
  drafts_enabled  BOOLEAN NOT NULL DEFAULT false,
  require_review  BOOLEAN NOT NULL DEFAULT false,
  reviewer_roles  JSONB   NOT NULL DEFAULT '["admin"]',
  auto_publish    BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_publish_schedule (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id     UUID NOT NULL REFERENCES zv_content_drafts(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  processed    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drafts_collection ON zv_content_drafts(collection, record_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status     ON zv_content_drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_created_by ON zv_content_drafts(created_by);
CREATE INDEX IF NOT EXISTS idx_publish_schedule  ON zv_publish_schedule(scheduled_at) WHERE NOT processed;

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

-- ── from 027_document_templates.sql ──
-- Migration: 027_document_templates
-- Admin-managed document templates + generation history

CREATE TABLE IF NOT EXISTS zv_document_templates (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT    NOT NULL,
  description   TEXT,
  template_type TEXT    NOT NULL DEFAULT 'html', -- html | markdown | handlebars | mustache
  output_format TEXT    NOT NULL DEFAULT 'pdf',  -- pdf | docx | html | markdown | txt
  content       TEXT    NOT NULL DEFAULT '',
  variables     JSONB   NOT NULL DEFAULT '{}',
  style_config  JSONB   NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_document_generations (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID    REFERENCES zv_document_templates(id) ON DELETE SET NULL,
  user_id       TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  variables     JSONB   NOT NULL DEFAULT '{}',
  output_format TEXT    NOT NULL DEFAULT 'pdf',
  status        TEXT    NOT NULL DEFAULT 'completed',
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_generations_template ON zv_document_generations(template_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_generations_user ON zv_document_generations(user_id);

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

CREATE TABLE IF NOT EXISTS zv_generated_docs (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       UUID    REFERENCES zv_doc_templates(id) ON DELETE SET NULL,
  template_name     TEXT    NOT NULL,
  source_collection TEXT,
  source_record_id  TEXT,
  document_number   TEXT    NOT NULL DEFAULT '',
  variables_data    JSONB   NOT NULL DEFAULT '{}',
  html_content      TEXT,
  generated_by      TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_templates_type ON zv_doc_templates(type, is_active);
CREATE INDEX IF NOT EXISTS idx_generated_docs_template ON zv_generated_docs(template_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_docs_source ON zv_generated_docs(source_collection, source_record_id);

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

-- === FAVORITES ===
CREATE TABLE IF NOT EXISTS zv_media_favorites (
  user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  file_id     UUID NOT NULL REFERENCES zv_media_files(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, file_id)
);

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

-- ── from 050_zones_pages_views.sql ──
-- Migration 060: Zones / Pages / Views — unified portal architecture
-- Replaces: zvd_portal_pages, zvd_portal_sections, zvd_portal_theme,
--           zvd_collection_views, zvd_portal_client_config
-- ═══════════════════════════════════════════════════════════════════

-- LAYER 1: Views — atomic reusable blocks
CREATE TABLE IF NOT EXISTS zvd_views (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        REFERENCES zv_tenants(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  description  TEXT,
  collection   TEXT        NOT NULL,
  view_type    TEXT        NOT NULL DEFAULT 'table'
                 CHECK (view_type IN ('table','kanban','calendar','gallery','stats','chart','list','timeline')),
  fields       JSONB       NOT NULL DEFAULT '[]',
  filters      JSONB       NOT NULL DEFAULT '[]',
  sort_field   TEXT,
  sort_dir     TEXT        DEFAULT 'desc' CHECK (sort_dir IN ('asc','desc')),
  page_size    INT         DEFAULT 20,
  config       JSONB       NOT NULL DEFAULT '{}',
  is_public    BOOLEAN     NOT NULL DEFAULT false,
  created_by   TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_views_collection ON zvd_views(collection);
CREATE INDEX IF NOT EXISTS idx_zvd_views_tenant     ON zvd_views(tenant_id);

-- LAYER 2: Zones — complete portals with own navigation, access rules, branding
CREATE TABLE IF NOT EXISTS zvd_zones (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        REFERENCES zv_tenants(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  slug           TEXT        NOT NULL,
  description    TEXT,
  is_active      BOOLEAN     NOT NULL DEFAULT false,
  access_roles   TEXT[]      NOT NULL DEFAULT '{}',
  base_path      TEXT        NOT NULL,
  -- Per-zone branding
  site_name      TEXT,
  site_logo_url  TEXT,
  primary_color  TEXT        DEFAULT '#069494',
  secondary_color TEXT,
  custom_css     TEXT,
  nav_position   TEXT        DEFAULT 'sidebar' CHECK (nav_position IN ('sidebar','topbar','both')),
  show_breadcrumbs BOOLEAN   NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_zvd_zones_slug   ON zvd_zones(slug);
CREATE INDEX IF NOT EXISTS idx_zvd_zones_tenant ON zvd_zones(tenant_id);

-- LAYER 3: Pages — view containers, belong to a Zone
CREATE TABLE IF NOT EXISTS zvd_pages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        REFERENCES zv_tenants(id) ON DELETE CASCADE,
  zone_id       UUID        NOT NULL REFERENCES zvd_zones(id) ON DELETE CASCADE,
  parent_id     UUID        REFERENCES zvd_pages(id) ON DELETE SET NULL,
  title         TEXT        NOT NULL,
  slug          TEXT        NOT NULL,
  icon          TEXT,
  description   TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  is_homepage   BOOLEAN     NOT NULL DEFAULT false,
  auth_required BOOLEAN     NOT NULL DEFAULT true,
  allowed_roles TEXT[]      NOT NULL DEFAULT '{}',
  sort_order    INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (zone_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_zvd_pages_zone   ON zvd_pages(zone_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_zvd_pages_tenant ON zvd_pages(tenant_id);

-- Junction Page ↔ View (M:N — a view can appear on multiple pages)
CREATE TABLE IF NOT EXISTS zvd_page_views (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID NOT NULL REFERENCES zvd_pages(id) ON DELETE CASCADE,
  view_id         UUID NOT NULL REFERENCES zvd_views(id) ON DELETE CASCADE,
  title_override  TEXT,
  col_span        INT  NOT NULL DEFAULT 12 CHECK (col_span BETWEEN 1 AND 12),
  sort_order      INT  NOT NULL DEFAULT 0,
  config_override JSONB NOT NULL DEFAULT '{}',
  UNIQUE (page_id, view_id)
);

CREATE INDEX IF NOT EXISTS idx_zvd_page_views_page ON zvd_page_views(page_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_zvd_page_views_view ON zvd_page_views(view_id);

-- ═══ SEED DATA ════════════════════════════════════════════════════════════

-- Seed default client zone
INSERT INTO zvd_zones (name, slug, description, is_active, base_path, site_name, primary_color, nav_position)
VALUES ('Client Portal', 'client', 'Portal for external clients', false, '/portal-client', 'Client Portal', '#069494', 'sidebar')
ON CONFLICT DO NOTHING;

-- Create default "intranet" zone
INSERT INTO zvd_zones (name, slug, description, is_active, base_path, access_roles, site_name, nav_position)
VALUES ('Intranet', 'intranet', 'Internal portal for staff', false, '/intranet', ARRAY['employee','manager'], 'Intranet', 'sidebar')
ON CONFLICT DO NOTHING;

-- ── from 051_fix_client_zone_base_path.sql ──
-- Align Client Portal zone base_path with the actual Studio route (/portal-client).
-- The original seed in 052 used "/portal/client" which never matched any Svelte route.
UPDATE zvd_zones
SET base_path = '/portal-client'
WHERE slug = 'client' AND base_path = '/portal/client';

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

-- Branch review comments
CREATE TABLE IF NOT EXISTS zvd_branch_comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   UUID NOT NULL,
  author_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  change_ref  TEXT,  -- optional reference to a specific change in branch.changes
  resolved    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE zv_schema_branches ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT NULL CHECK (review_status IN ('pending','approved','changes_requested','rejected'));
ALTER TABLE zv_schema_branches ADD COLUMN IF NOT EXISTS review_requested_by TEXT;
ALTER TABLE zv_schema_branches ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_branch_reviews ON zvd_branch_review_requests(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_branch_comments ON zvd_branch_comments(branch_id, created_at DESC);

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
  ADD COLUMN IF NOT EXISTS refresh_interval INT;

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

-- DOWN

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
DROP TABLE IF EXISTS zv_media_favorites;
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
DROP TABLE IF EXISTS zv_generated_docs;
DROP INDEX IF EXISTS idx_doc_templates_type;
DROP TABLE IF EXISTS zv_doc_templates;

-- ── DOWN from 027_document_templates.sql ──
DROP INDEX IF EXISTS idx_doc_generations_user;
DROP INDEX IF EXISTS idx_doc_generations_template;
DROP TABLE IF EXISTS zv_document_generations;
DROP TABLE IF EXISTS zv_document_templates;

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
DROP TABLE IF EXISTS zv_publish_schedule;
DROP TABLE IF EXISTS zv_collection_publish_settings;
DROP INDEX IF EXISTS idx_drafts_created_by;
DROP INDEX IF EXISTS idx_drafts_status;
DROP INDEX IF EXISTS idx_drafts_collection;
DROP TABLE IF EXISTS zv_content_drafts;

-- ── DOWN from 021_approvals.sql ──
DROP INDEX IF EXISTS idx_approval_decisions_request;
DROP TABLE IF EXISTS zv_approval_decisions;
DROP INDEX IF EXISTS idx_approval_requests_by;
DROP INDEX IF EXISTS idx_approval_requests_status;
DROP INDEX IF EXISTS idx_approval_requests_collection;
DROP TABLE IF EXISTS zv_approval_requests;
DROP INDEX IF EXISTS idx_approval_steps_workflow;
DROP TABLE IF EXISTS zv_approval_steps;
DROP INDEX IF EXISTS idx_approval_workflows_collection;
DROP TABLE IF EXISTS zv_approval_workflows;

-- ── DOWN from 020_pages.sql ──
DROP INDEX IF EXISTS idx_zv_form_submissions_status;
DROP INDEX IF EXISTS idx_zv_form_submissions_section;
DROP INDEX IF EXISTS idx_zv_form_submissions_page;
DROP TABLE IF EXISTS zv_form_submissions;
DROP INDEX IF EXISTS idx_zv_page_sections_type;
DROP INDEX IF EXISTS idx_zv_page_sections_page;
DROP TABLE IF EXISTS zv_page_sections;
DROP INDEX IF EXISTS idx_zv_pages_active;
DROP INDEX IF EXISTS idx_zv_pages_homepage;
DROP INDEX IF EXISTS idx_zv_pages_slug;
DROP TABLE IF EXISTS zv_pages;

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

-- ── DOWN from 009_translations.sql ──
DROP TABLE IF EXISTS zvd_locales;
DROP INDEX IF EXISTS idx_zvd_translations_locale;
DROP INDEX IF EXISTS idx_zvd_translations_key_locale;
DROP TABLE IF EXISTS zvd_translations;
DROP INDEX IF EXISTS idx_zvd_translation_keys_context;
DROP INDEX IF EXISTS idx_zvd_translation_keys_key;
DROP TABLE IF EXISTS zvd_translation_keys;

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
DROP INDEX IF EXISTS idx_zvd_audit_log_created;
DROP INDEX IF EXISTS idx_zvd_audit_log_record;
DROP INDEX IF EXISTS idx_zvd_audit_log_table;
DROP TABLE IF EXISTS zvd_audit_log;
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
