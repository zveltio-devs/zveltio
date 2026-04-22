/**
 * packages/engine/src/db/schema.ts
 *
 * Complete Kysely type-safe schema for all database tables.
 * NEVER use `as any` in Kysely queries — if a table is missing, add it here.
 *
 * Rules:
 * - System tables: prefix `zv_`
 * - Data/portal tables: prefix `zvd_`
 * - Better-Auth tables: no prefix (user, session, account, verification, twoFactor)
 * - User-created collection tables (`zvd_<collection>`) are dynamic and use db/dynamic.ts
 */

import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

// ─────────────────────────────────────────────────────────────────────────────
// Better-Auth tables
// ─────────────────────────────────────────────────────────────────────────────

export interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionTable {
  id: string;
  expiresAt: Date;
  token: string;
  createdAt: Date;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

export interface AccountTable {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  password: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TwoFactorTable {
  id: string;
  secret: string;
  backupCodes: string;
  userId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core system tables (prefix zv_)
// ─────────────────────────────────────────────────────────────────────────────

export interface ZvMigrationsTable {
  id: Generated<number>;
  name: string;
  applied_at: Generated<Date>;
}

export interface ZvSchemaVersionsTable {
  id: Generated<number>;
  version: string;
  name: string;
  filename: string;
  checksum: string | null;
  applied_at: Generated<Date>;
  engine_version: string | null;
  execution_ms: number | null;
  rolled_back_at: Date | null;
}

export interface ZvSettingsTable {
  key: string;
  value: unknown; // JSONB
  description: string | null;
  is_public: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvDdlJobsTable {
  id: Generated<string>;
  type: string;
  payload: unknown; // JSONB
  status: 'pending' | 'running' | 'done' | 'failed';
  error: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  started_at: Date | null;
  completed_at: Date | null;
  retry_count: number;
  max_retries: number;
}

export interface ZvApiKeysTable {
  id: Generated<string>;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: unknown; // JSONB — Array<{ collection: string; actions: string[] }>
  rate_limit: number;
  expires_at: Date | null;
  last_used_at: Date | null;
  is_active: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  allowed_ips: unknown; // JSONB
  organization: string | null;
  description: string | null;
  permissions_mode: string | null;
  casbin_subject: string | null;
  request_count: number;
  last_ip: string | null;
}

export interface ZvApiKeyAccessLogTable {
  id: Generated<string>;
  api_key_id: string;
  ip_address: string | null;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number | null;
  created_at: Generated<Date>;
}

export interface ZvRolesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  created_at: Generated<Date>;
}

export interface ZvTenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise' | 'custom';
  status: 'active' | 'suspended' | 'deleted';
  max_records: number;
  max_storage_gb: number;
  max_api_calls_day: number;
  max_users: number;
  billing_email: string | null;
  trial_ends_at: Date | null;
  settings: unknown; // JSONB
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvTenantUsersTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  invited_by: string | null;
  joined_at: Generated<Date>;
}

export interface ZvTenantUsageTable {
  id: Generated<string>;
  tenant_id: string;
  date: Date;
  api_calls: number;
  storage_bytes: number;
  record_count: number;
}

export interface ZvEnvironmentsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  slug: string;
  schema_name: string;
  is_production: boolean;
  color: string | null;
  settings: unknown; // JSONB
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvFlowsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  trigger_type: 'manual' | 'on_create' | 'on_update' | 'on_delete' | 'cron' | 'webhook';
  trigger_config: unknown; // JSONB
  trigger: unknown; // JSONB — alias used in some routes
  is_active: boolean;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvFlowStepsTable {
  id: Generated<string>;
  flow_id: string;
  step_order: number;
  name: string;
  type: 'run_script' | 'send_email' | 'webhook' | 'query_db' | 'condition' | 'transform' | 'delay' | 'send_notification' | 'export_collection' | 'ai_decision';
  config: unknown; // JSONB
  on_error: 'stop' | 'continue' | 'retry';
  created_at: Generated<Date>;
}

export interface ZvFlowRunsTable {
  id: Generated<string>;
  flow_id: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  trigger_data: unknown; // JSONB
  output: unknown; // JSONB
  error: string | null;
  started_at: Generated<Date>;
  finished_at: Date | null;
}

export interface ZvFlowDlqTable {
  id: Generated<string>;
  flow_id: string;
  payload: unknown; // JSONB
  error: string | null;
  created_at: Generated<Date>;
}

export interface ZvWebhooksTable {
  id: Generated<string>;
  name: string;
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  headers: unknown; // JSONB
  events: unknown; // JSONB — string[]
  collections: unknown; // JSONB — string[]
  active: boolean;
  secret: string | null;
  retry_attempts: number;
  timeout: number;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvWebhookDeliveriesTable {
  id: Generated<string>;
  webhook_id: string;
  payload: unknown; // JSONB
  url: string;
  method: string;
  headers: unknown; // JSONB
  attempt: number;
  max_attempts: number;
  status: string;
  response_body: string | null;
  error: string | null;
  delivered_at: Date | null;
  created_at: Generated<Date>;
}

export interface ZvNotificationsTable {
  id: Generated<string>;
  user_id: string;
  title: string;
  message: string;
  type: string;
  action_url: string | null;
  is_read: boolean;
  source: string | null;
  metadata: unknown; // JSONB
  created_at: Generated<Date>;
}

export interface ZvPushSubscriptionsTable {
  id: Generated<string>;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: Generated<Date>;
}

export interface ZvMediaFoldersTable {
  id: Generated<string>;
  name: string;
  parent_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface ZvMediaFilesTable {
  id: Generated<string>;
  folder_id: string | null;
  filename: string;
  original_name: string;
  mimetype: string;
  size: number;
  storage_path: string;
  url: string;
  width: number | null;
  height: number | null;
  metadata: unknown; // JSONB
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  title: string | null;
  description: string | null;
  alt_text: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
}

export interface ZvMediaTagsTable {
  id: Generated<string>;
  name: string;
  color: string | null;
  created_at: Generated<Date>;
}

export interface ZvMediaFileTagsTable {
  file_id: string;
  tag_id: string;
}

export interface ZvMediaVersionsTable {
  id: Generated<string>;
  file_id: string;
  version_num: number;
  storage_path: string;
  size_bytes: number;
  mime_type: string;
  checksum: string | null;
  uploaded_by: string | null;
  created_at: Generated<Date>;
}

export interface ZvMediaSharesTable {
  id: Generated<string>;
  file_id: string | null;
  folder_id: string | null;
  token: string;
  share_type: string;
  password_hash: string | null;
  expires_at: Date | null;
  max_downloads: number | null;
  download_count: number;
  created_by: string | null;
  is_active: boolean;
  created_at: Generated<Date>;
}

export interface ZvMediaFavoritesTable {
  user_id: string;
  file_id: string;
  created_at: Generated<Date>;
}

export interface ZvStorageQuotasTable {
  user_id: string;
  quota_bytes: number;
  used_bytes: number;
  updated_at: Generated<Date>;
}

export interface ZvImportLogsTable {
  id: Generated<string>;
  collection: string;
  filename: string;
  file_format: string;
  status: string;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  error_rows: number;
  errors: unknown; // JSONB
  options: unknown; // JSONB
  created_by: string | null;
  created_at: Generated<Date>;
  completed_at: Date | null;
}

export interface ZvBackupsTable {
  id: Generated<string>;
  filename: string;
  size_bytes: number | null;
  status: string;
  error: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  completed_at: Date | null;
}

export interface ZvAiProvidersTable {
  id: Generated<string>;
  name: string;
  label: string;
  api_key: string | null;
  base_url: string | null;
  default_model: string | null;
  is_active: boolean;
  is_default: boolean;
  metadata: unknown; // JSONB
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvPromptTemplatesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  system_prompt: string | null;
  user_template: string;
  variables: unknown; // JSONB
  category: string | null;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  max_tokens: number | null;
  is_active: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvAiChatsTable {
  id: Generated<string>;
  title: string | null;
  user_id: string;
  provider: string | null;
  model: string | null;
  context: unknown; // JSONB
  messages: unknown; // JSONB
  metadata: unknown; // JSONB
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvRagDocumentsTable {
  id: Generated<string>;
  title: string;
  content: string;
  chunk_index: number;
  source_url: string | null;
  source_type: string | null;
  collection: string | null;
  record_id: string | null;
  namespace: string | null;
  metadata: unknown; // JSONB
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface ZvAiQueriesTable {
  id: Generated<string>;
  user_id: string | null;
  prompt: string;
  generated_sql: string | null;
  result_count: number | null;
  execution_ms: number | null;
  ai_analysis: string | null;
  chart_config: unknown; // JSONB
  is_saved: boolean;
  title: string | null;
  error: string | null;
  created_at: Generated<Date>;
}

export interface ZvAiMemoryTable {
  id: Generated<string>;
  user_id: string;
  context_key: string;
  content: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvExtensionRegistryTable {
  id: Generated<string>;
  name: string;
  display_name: string;
  description: string | null;
  category: string;
  version: string;
  author: string;
  is_installed: boolean;
  is_enabled: boolean;
  config: unknown; // JSONB
  installed_at: Date | null;
  enabled_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvEdgeFunctionsTable {
  id: Generated<string>;
  name: string;
  display_name: string | null;
  description: string | null;
  code: string;
  runtime: string;
  http_method: string;
  path: string;
  is_active: boolean;
  timeout_ms: number;
  env_vars: unknown; // JSONB
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvEdgeFunctionLogsTable {
  id: Generated<string>;
  function_id: string;
  status: string;
  duration_ms: number | null;
  request_body: unknown; // JSONB
  response_body: unknown; // JSONB
  error: string | null;
  created_at: Generated<Date>;
}

export interface ZvAuditLogTable {
  id: Generated<string>;
  event_type: string;
  user_id: string | null;
  resource_id: string | null;
  resource_type: string | null;
  metadata: unknown; // JSONB
  ip: string | null;
  created_at: Generated<Date>;
}

export interface ZvRevisionsTable {
  id: Generated<string>;
  collection: string;
  record_id: string;
  action: string;
  data: unknown; // JSONB
  delta: unknown; // JSONB
  user_id: string | null;
  created_at: Generated<Date>;
}

export interface ZvRequestLogsTable {
  id: Generated<number>;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
}

export interface ZvSlowQueriesTable {
  id: Generated<string>;
  method: string;
  path: string;
  query_params: unknown; // JSONB
  status_code: number;
  duration_ms: number;
  created_at: Generated<Date>;
}

export interface ZvPitrConfigTable {
  id: Generated<string>;
  is_enabled: boolean;
  wal_archive_path: string | null;
  retention_days: number;
  last_base_backup_at: Date | null;
  last_wal_segment: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvPitrRestorePointsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  lsn: string;
  recorded_at: Generated<Date>;
  created_by: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data/content tables (prefix zvd_)
// ─────────────────────────────────────────────────────────────────────────────

export interface ZvdCollectionsTable {
  id: Generated<string>;
  name: string;
  display_name: string | null;
  icon: string | null;
  route_group: string | null;
  is_permissioned: boolean;
  sort: number | null;
  singular_name: string | null;
  description: string | null;
  fields: unknown; // JSONB
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  source_type: string | null;
  virtual_config: unknown; // JSONB
  is_managed: boolean;
  ai_search_enabled: boolean;
  ai_search_field: string | null;
  ai_embed_excluded_fields: unknown; // JSONB
  is_system: boolean;
  schema_locked: boolean;
}

export interface ZvdRelationsTable {
  id: Generated<string>;
  name: string;
  type: string;
  source_collection: string;
  source_field: string;
  target_collection: string;
  target_field: string | null;
  junction_table: string | null;
  foreign_key_constraint: string | null;
  on_delete: string | null;
  on_update: string | null;
  metadata: unknown; // JSONB
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdPermissionsTable {
  id: Generated<string>;
  ptype: string;
  v0: string;
  v1: string;
  v2: string;
  v3: string | null;
  v4: string | null;
  v5: string | null;
  created_at: Generated<Date>;
}

export interface ZvdAuditLogTable {
  id: Generated<string>;
  table_name: string;
  record_id: string;
  action: string;
  old_data: unknown; // JSONB
  new_data: unknown; // JSONB
  user_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
}

export interface ZvdWebhooksTable {
  id: Generated<string>;
  name: string;
  url: string;
  method: string;
  headers: unknown; // JSONB
  events: unknown; // JSONB
  collections: unknown; // JSONB
  active: boolean;
  secret: string | null;
  retry_attempts: number;
  timeout: number;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdWebhookDeliveriesTable {
  id: Generated<string>;
  webhook_id: string;
  payload: unknown; // JSONB
  url: string;
  method: string;
  headers: unknown; // JSONB
  attempt: number;
  max_attempts: number;
  status: string;
  response_body: string | null;
  error: string | null;
  delivered_at: Date | null;
  created_at: Generated<Date>;
}

export interface ZvdAiEmbeddingsTable {
  id: Generated<string>;
  collection: string;
  record_id: string;
  field: string;
  text_content: string;
  embedding: unknown; // pgvector
  model: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdAiSearchConfigTable {
  id: Generated<string>;
  collection: string;
  fields: unknown; // JSONB
  namespace: string | null;
  is_enabled: boolean;
  created_at: Generated<Date>;
}

export interface ZvdTranslationKeysTable {
  id: Generated<string>;
  key: string;
  context: string | null;
  default_value: string | null;
  description: string | null;
  tags: unknown; // JSONB
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdTranslationsTable {
  id: Generated<string>;
  key_id: string;
  locale: string;
  value: string;
  is_machine_translated: boolean;
  reviewed: boolean;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdLocalesTable {
  code: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
  created_at: Generated<Date>;
}

export interface ZvdContactsTable {
  id: Generated<string>;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  job_title: string | null;
  avatar_url: string | null;
  address: unknown; // JSONB
  tags: unknown; // JSONB
  notes: string | null;
  source: string | null;
  external_id: string | null;
  metadata: unknown; // JSONB
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdOrganizationsTable {
  id: Generated<string>;
  name: string;
  legal_name: string | null;
  tax_id: string | null;
  registration_no: string | null;
  type: string | null;
  industry: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  address: unknown; // JSONB
  billing_address: unknown; // JSONB
  logo_url: string | null;
  tags: unknown; // JSONB
  metadata: unknown; // JSONB
  is_active: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdContactOrganizationsTable {
  contact_id: string;
  organization_id: string;
  role: string | null;
  is_primary: boolean;
}

export interface ZvdTransactionsTable {
  id: Generated<string>;
  type: string;
  status: string;
  number: string | null;
  organization_id: string | null;
  contact_id: string | null;
  currency: string;
  amount: number;
  tax_amount: number;
  total_amount: number;
  due_date: Date | null;
  paid_date: Date | null;
  line_items: unknown; // JSONB
  notes: string | null;
  reference: string | null;
  metadata: unknown; // JSONB
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Portal tables — OLD (kept for backward compat, renamed in migration 061)
// ─────────────────────────────────────────────────────────────────────────────

export interface ZvdPortalThemeTable {
  id: Generated<string>;
  tenant_id: string | null;
  app_name: string;
  logo_url: string | null;
  favicon_url: string | null;
  color_primary: string;
  color_secondary: string;
  color_accent: string;
  color_neutral: string;
  color_base_100: string;
  color_base_200: string;
  color_base_300: string;
  font_family: string;
  font_size_base: string;
  border_radius: string;
  color_scheme: 'light' | 'dark' | 'auto';
  custom_css: string | null;
  nav_position: string;
  footer_text: string | null;
  meta_title: string | null;
  meta_description: string | null;
  updated_at: Generated<Date>;
}

export interface ZvdPortalPagesTable {
  id: Generated<string>;
  tenant_id: string | null;
  slug: string;
  title: string;
  icon: string | null;
  description: string | null;
  layout: string;
  is_active: boolean;
  is_homepage: boolean;
  auth_required: boolean;
  allowed_roles: string[];
  parent_id: string | null;
  sort_order: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdPortalSectionsTable {
  id: Generated<string>;
  tenant_id: string | null;
  page_id: string;
  view_type: string;
  title: string | null;
  collection: string | null;
  collection_view_id: string | null;
  config: unknown; // JSONB
  sort_order: number;
  col_span: number;
  is_visible: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdCollectionViewsTable {
  id: Generated<string>;
  tenant_id: string | null;
  collection: string;
  name: string;
  view_type: string;
  config: unknown; // JSONB
  is_default: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}


// ─────────────────────────────────────────────────────────────────────────────
// NEW Portal tables — Zones / Pages / Views (migration 060)
// ─────────────────────────────────────────────────────────────────────────────

export interface ZvdViewsTable {
  id: Generated<string>;
  tenant_id: string | null;
  name: string;
  description: string | null;
  collection: string;
  view_type: 'table' | 'kanban' | 'calendar' | 'gallery' | 'stats' | 'chart' | 'list' | 'timeline';
  fields: unknown; // JSONB
  filters: unknown; // JSONB
  sort_field: string | null;
  sort_dir: 'asc' | 'desc' | null;
  page_size: number;
  config: unknown; // JSONB
  is_public: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdZonesTable {
  id: Generated<string>;
  tenant_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  is_active: boolean;
  access_roles: string[];
  base_path: string;
  site_name: string | null;
  site_logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  custom_css: string | null;
  nav_position: 'sidebar' | 'topbar' | 'both';
  show_breadcrumbs: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdPagesTable {
  id: Generated<string>;
  tenant_id: string | null;
  zone_id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  icon: string | null;
  description: string | null;
  is_active: boolean;
  is_homepage: boolean;
  auth_required: boolean;
  allowed_roles: string[];
  sort_order: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdPageViewsTable {
  id: Generated<string>;
  page_id: string;
  view_id: string;
  title_override: string | null;
  col_span: number;
  sort_order: number;
  config_override: unknown; // JSONB
}

// ─────────────────────────────────────────────────────────────────────────────
// Content/workflow tables
// ─────────────────────────────────────────────────────────────────────────────

export interface ZvPagesTable {
  id: Generated<string>;
  title: string;
  slug: string;
  description: string | null;
  meta_title: string | null;
  meta_description: string | null;
  og_image: string | null;
  is_active: boolean;
  is_homepage: boolean;
  layout: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvPageSectionsTable {
  id: Generated<string>;
  page_id: string;
  name: string | null;
  type: string;
  sort_order: number;
  is_visible: boolean;
  collection: string | null;
  filter_config: unknown; // JSONB
  sort_config: unknown; // JSONB
  limit_count: number | null;
  fields: unknown; // JSONB
  slug_field: string | null;
  static_content: unknown; // JSONB
  style_config: unknown; // JSONB
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvFormSubmissionsTable {
  id: Generated<string>;
  page_id: string;
  section_id: string | null;
  data: unknown; // JSONB
  submitter_ip: string | null;
  submitter_email: string | null;
  status: string;
  created_at: Generated<Date>;
}

export interface ZvApprovalWorkflowsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  collection: string;
  trigger_field: string;
  trigger_value: string;
  is_active: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvApprovalStepsTable {
  id: Generated<string>;
  workflow_id: string;
  step_order: number;
  name: string;
  approver_role: string | null;
  approver_user_id: string | null;
  deadline_hours: number | null;
  is_required: boolean;
  created_at: Generated<Date>;
}

export interface ZvApprovalRequestsTable {
  id: Generated<string>;
  workflow_id: string;
  collection: string;
  record_id: string;
  current_step_id: string | null;
  status: string;
  requested_by: string;
  requested_at: Generated<Date>;
  completed_at: Date | null;
  metadata: unknown; // JSONB
}

export interface ZvApprovalDecisionsTable {
  id: Generated<string>;
  request_id: string;
  step_id: string;
  decision: string;
  decided_by: string;
  comment: string | null;
  decided_at: Generated<Date>;
}

export interface ZvContentDraftsTable {
  id: Generated<string>;
  collection: string;
  record_id: string | null;
  draft_data: unknown; // JSONB
  base_version: number | null;
  status: string;
  notes: string | null;
  scheduled_at: Date | null;
  published_at: Date | null;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvCollectionPublishSettingsTable {
  id: Generated<string>;
  collection: string;
  drafts_enabled: boolean;
  require_review: boolean;
  reviewer_roles: unknown; // JSONB
  auto_publish: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvPublishScheduleTable {
  id: Generated<string>;
  draft_id: string;
  scheduled_at: Date;
  processed: boolean;
  created_at: Generated<Date>;
}

export interface ZvSavedQueriesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  collection: string;
  config: unknown; // JSONB
  is_shared: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvValidationRulesTable {
  id: Generated<string>;
  collection: string;
  field_name: string;
  rule_type: string;
  nl_description: string | null;
  rule_config: unknown; // JSONB
  error_message: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvQualityScansTable {
  id: Generated<string>;
  collection: string;
  scan_type: string;
  status: string;
  records_scanned: number;
  issues_found: number;
  triggered_by: string | null;
  started_at: Generated<Date>;
  completed_at: Date | null;
}

export interface ZvQualityIssuesTable {
  id: Generated<string>;
  scan_id: string;
  collection: string;
  issue_type: string;
  severity: string;
  record_ids: unknown; // JSONB
  field_name: string | null;
  description: string;
  suggestion: string | null;
  auto_fixable: boolean;
  dismissed: boolean;
  created_at: Generated<Date>;
}

export interface ZvDashboardsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  icon: string | null;
  is_default: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvPanelsTable {
  id: Generated<string>;
  dashboard_id: string;
  name: string;
  type: string;
  query: unknown; // JSONB
  config: unknown; // JSONB
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvDocumentTemplatesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  template_type: string;
  output_format: string;
  content: string;
  variables: unknown; // JSONB
  style_config: unknown; // JSONB
  is_active: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvDocumentGenerationsTable {
  id: Generated<string>;
  template_id: string;
  user_id: string | null;
  variables: unknown; // JSONB
  output_format: string;
  status: string;
  generated_at: Date | null;
  created_at: Generated<Date>;
}

export interface ZvDocTemplatesTable {
  id: Generated<string>;
  name: string;
  type: string;
  description: string | null;
  template_html: string | null;
  template_text: string | null;
  variables: unknown; // JSONB
  source_collection: string | null;
  field_mapping: unknown; // JSONB
  prefix: string | null;
  counter: number;
  is_active: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvGeneratedDocsTable {
  id: Generated<string>;
  template_id: string;
  template_name: string;
  source_collection: string | null;
  source_record_id: string | null;
  document_number: string;
  variables_data: unknown; // JSONB
  html_content: string | null;
  generated_by: string | null;
  generated_at: Generated<Date>;
}

export interface ZvSchemaBranchesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  base_schema: unknown; // JSONB
  branch_schema: unknown; // JSONB
  status: string;
  changes: unknown; // JSONB
  created_by: string | null;
  merged_by: string | null;
  merged_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvRecordCommentsTable {
  id: Generated<string>;
  collection: string;
  record_id: string;
  comment: string;
  user_id: string | null;
  parent_id: string | null;
  is_resolved: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// Mail tables
export interface ZvMailAccountsTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  email_address: string;
  display_name: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_secure: boolean;
  imap_user: string | null;
  imap_password: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  smtp_user: string | null;
  smtp_password: string | null;
  is_default: boolean;
  is_active: boolean;
  last_sync_at: Date | null;
  sync_error: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  oauth2_provider: string | null;
  oauth2_access_token: string | null;
  oauth2_refresh_token: string | null;
  oauth2_expires_at: Date | null;
  imap_idle_supported: boolean;
  sieve_host: string | null;
  sieve_port: number | null;
}

export interface ZvMailFoldersTable {
  id: Generated<string>;
  account_id: string;
  name: string;
  path: string;
  type: string | null;
  unread_count: number;
  total_count: number;
  last_uid: number | null;
  created_at: Generated<Date>;
}

export interface ZvMailMessagesTable {
  id: Generated<string>;
  account_id: string;
  folder_id: string;
  message_id: string | null;
  uid: number | null;
  thread_id: string | null;
  from_address: string;
  from_name: string | null;
  to_addresses: unknown; // JSONB
  cc_addresses: unknown; // JSONB
  bcc_addresses: unknown; // JSONB
  reply_to: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  snippet: string | null;
  is_read: boolean;
  is_starred: boolean;
  is_draft: boolean;
  has_attachments: boolean;
  sent_at: Date | null;
  received_at: Date | null;
  tags: unknown; // JSONB
  raw_headers: unknown; // JSONB
  created_at: Generated<Date>;
  priority: string | null;
  read_receipt_requested: boolean;
  read_receipt_sent: boolean;
  is_encrypted: boolean;
  is_signed: boolean;
  references_header: string | null;
  in_reply_to: string | null;
}

export interface ZvMailAttachmentsTable {
  id: Generated<string>;
  message_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  content_id: string | null;
  is_inline: boolean;
  created_at: Generated<Date>;
}

export interface ZvMailIdentitiesTable {
  id: Generated<string>;
  account_id: string;
  email_address: string;
  display_name: string | null;
  reply_to: string | null;
  bcc_self: boolean;
  is_default: boolean;
  sort_order: number;
  signature_id: string | null;
  created_at: Generated<Date>;
}

export interface ZvMailSignaturesTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  body_html: string;
  body_text: string | null;
  is_default: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvMailDraftsTable {
  id: Generated<string>;
  account_id: string;
  identity_id: string | null;
  to_addresses: unknown; // JSONB
  cc_addresses: unknown; // JSONB
  bcc_addresses: unknown; // JSONB
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  in_reply_to: string | null;
  references_hdr: string | null;
  reply_type: string | null;
  original_msg_id: string | null;
  attachments: unknown; // JSONB
  priority: string | null;
  request_read_receipt: boolean;
  imap_uid: number | null;
  auto_saved_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvMailFiltersTable {
  id: Generated<string>;
  account_id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  conditions: unknown; // JSONB
  actions: unknown; // JSONB
  sieve_script: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvMailContactsTable {
  id: Generated<string>;
  user_id: string;
  email: string;
  display_name: string | null;
  company: string | null;
  phone: string | null;
  frequency: number;
  last_used_at: Date | null;
  source: string | null;
  created_at: Generated<Date>;
}

export interface ZvMailPgpKeysTable {
  id: Generated<string>;
  user_id: string;
  email: string;
  public_key: string;
  private_key: string | null;
  fingerprint: string;
  is_own: boolean;
  expires_at: Date | null;
  created_at: Generated<Date>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Complete Database interface — used as Kysely<DbSchema>
// ─────────────────────────────────────────────────────────────────────────────

export interface DbSchema {
  // Better-Auth
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;
  twoFactor: TwoFactorTable;

  // System (prefix zv_)
  zv_migrations: ZvMigrationsTable;
  zv_schema_versions: ZvSchemaVersionsTable;
  zv_settings: ZvSettingsTable;
  zv_ddl_jobs: ZvDdlJobsTable;
  zv_api_keys: ZvApiKeysTable;
  zv_api_key_access_log: ZvApiKeyAccessLogTable;
  zv_roles: ZvRolesTable;
  zv_tenants: ZvTenantsTable;
  zv_tenant_users: ZvTenantUsersTable;
  zv_tenant_usage: ZvTenantUsageTable;
  zv_environments: ZvEnvironmentsTable;
  zv_flows: ZvFlowsTable;
  zv_flow_steps: ZvFlowStepsTable;
  zv_flow_runs: ZvFlowRunsTable;
  zv_flow_dlq: ZvFlowDlqTable;
  zv_webhooks: ZvWebhooksTable;
  zv_webhook_deliveries: ZvWebhookDeliveriesTable;
  zv_notifications: ZvNotificationsTable;
  zv_push_subscriptions: ZvPushSubscriptionsTable;
  zv_media_folders: ZvMediaFoldersTable;
  zv_media_files: ZvMediaFilesTable;
  zv_media_tags: ZvMediaTagsTable;
  zv_media_file_tags: ZvMediaFileTagsTable;
  zv_media_versions: ZvMediaVersionsTable;
  zv_media_shares: ZvMediaSharesTable;
  zv_media_favorites: ZvMediaFavoritesTable;
  zv_storage_quotas: ZvStorageQuotasTable;
  zv_import_logs: ZvImportLogsTable;
  zv_backups: ZvBackupsTable;
  zv_ai_providers: ZvAiProvidersTable;
  zv_prompt_templates: ZvPromptTemplatesTable;
  zv_ai_chats: ZvAiChatsTable;
  zv_rag_documents: ZvRagDocumentsTable;
  zv_ai_queries: ZvAiQueriesTable;
  zv_ai_memory: ZvAiMemoryTable;
  zv_extension_registry: ZvExtensionRegistryTable;
  zv_edge_functions: ZvEdgeFunctionsTable;
  zv_edge_function_logs: ZvEdgeFunctionLogsTable;
  zv_audit_log: ZvAuditLogTable;
  zv_revisions: ZvRevisionsTable;
  zv_slow_queries: ZvSlowQueriesTable;
  zv_request_logs: ZvRequestLogsTable;
  zv_pitr_config: ZvPitrConfigTable;
  zv_pitr_restore_points: ZvPitrRestorePointsTable;
  zv_pages: ZvPagesTable;
  zv_page_sections: ZvPageSectionsTable;
  zv_form_submissions: ZvFormSubmissionsTable;
  zv_approval_workflows: ZvApprovalWorkflowsTable;
  zv_approval_steps: ZvApprovalStepsTable;
  zv_approval_requests: ZvApprovalRequestsTable;
  zv_approval_decisions: ZvApprovalDecisionsTable;
  zv_content_drafts: ZvContentDraftsTable;
  zv_collection_publish_settings: ZvCollectionPublishSettingsTable;
  zv_publish_schedule: ZvPublishScheduleTable;
  zv_saved_queries: ZvSavedQueriesTable;
  zv_validation_rules: ZvValidationRulesTable;
  zv_quality_scans: ZvQualityScansTable;
  zv_quality_issues: ZvQualityIssuesTable;
  zv_dashboards: ZvDashboardsTable;
  zv_panels: ZvPanelsTable;
  zv_document_templates: ZvDocumentTemplatesTable;
  zv_document_generations: ZvDocumentGenerationsTable;
  zv_doc_templates: ZvDocTemplatesTable;
  zv_generated_docs: ZvGeneratedDocsTable;
  zv_schema_branches: ZvSchemaBranchesTable;
  zv_record_comments: ZvRecordCommentsTable;
  zv_mail_accounts: ZvMailAccountsTable;
  zv_mail_folders: ZvMailFoldersTable;
  zv_mail_messages: ZvMailMessagesTable;
  zv_mail_attachments: ZvMailAttachmentsTable;
  zv_mail_identities: ZvMailIdentitiesTable;
  zv_mail_signatures: ZvMailSignaturesTable;
  zv_mail_drafts: ZvMailDraftsTable;
  zv_mail_filters: ZvMailFiltersTable;
  zv_mail_contacts: ZvMailContactsTable;
  zv_mail_pgp_keys: ZvMailPgpKeysTable;
  // Data/portal (prefix zvd_)
  zvd_collections: ZvdCollectionsTable;
  zvd_relations: ZvdRelationsTable;
  zvd_permissions: ZvdPermissionsTable;
  zvd_audit_log: ZvdAuditLogTable;
  zvd_webhooks: ZvdWebhooksTable;
  zvd_webhook_deliveries: ZvdWebhookDeliveriesTable;
  zvd_ai_embeddings: ZvdAiEmbeddingsTable;
  zvd_ai_search_config: ZvdAiSearchConfigTable;
  zvd_translation_keys: ZvdTranslationKeysTable;
  zvd_translations: ZvdTranslationsTable;
  zvd_locales: ZvdLocalesTable;
  zvd_contacts: ZvdContactsTable;
  zvd_organizations: ZvdOrganizationsTable;
  zvd_contact_organizations: ZvdContactOrganizationsTable;
  zvd_transactions: ZvdTransactionsTable;
  // Portal old (renamed in migration 061, kept for transition)
  zvd_portal_theme: ZvdPortalThemeTable;
  zvd_portal_pages: ZvdPortalPagesTable;
  zvd_portal_sections: ZvdPortalSectionsTable;
  zvd_collection_views: ZvdCollectionViewsTable;
  // Portal new — Zones / Pages / Views
  zvd_views: ZvdViewsTable;
  zvd_zones: ZvdZonesTable;
  zvd_pages: ZvdPagesTable;
  zvd_page_views: ZvdPageViewsTable;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience types (Selectable / Insertable / Updateable)
// ─────────────────────────────────────────────────────────────────────────────

export type ZvdCollectionRow = Selectable<ZvdCollectionsTable>;
export type NewZvdCollection = Insertable<ZvdCollectionsTable>;
export type ZvdCollectionUpdate = Updateable<ZvdCollectionsTable>;

export type ZvApiKeyRow = Selectable<ZvApiKeysTable>;
export type NewZvApiKey = Insertable<ZvApiKeysTable>;

export type ZvdViewRow = Selectable<ZvdViewsTable>;
export type NewZvdView = Insertable<ZvdViewsTable>;
export type ZvdViewUpdate = Updateable<ZvdViewsTable>;

export type ZvdZoneRow = Selectable<ZvdZonesTable>;
export type NewZvdZone = Insertable<ZvdZonesTable>;
export type ZvdZoneUpdate = Updateable<ZvdZonesTable>;

export type ZvdPageRow = Selectable<ZvdPagesTable>;
export type NewZvdPage = Insertable<ZvdPagesTable>;
export type ZvdPageUpdate = Updateable<ZvdPagesTable>;

export type ZvdPageViewRow = Selectable<ZvdPageViewsTable>;
export type NewZvdPageView = Insertable<ZvdPageViewsTable>;
