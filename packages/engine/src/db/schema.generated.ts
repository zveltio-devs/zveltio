/**
 * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with `bun run scripts/schema-codegen.ts` from the repo root.
 * Sources: every *.sql file under
 *   - packages/engine/src/db/migrations/sql/
 *   - $EXTENSIONS_ROOT (default: ../zveltio-extensions) / <ext>/engine/migrations/
 *
 * Sister checker: `scripts/schema-drift-check.ts` diffs this output
 * against route/lib usage and flags mismatches.
 */

// biome-ignore-all lint/style/useNamingConvention: PG column names + Better-Auth use mixed conventions

import type { Generated } from 'kysely';

export interface AccountTable {
  id: Generated<string>;
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
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  issuer: string | null;
}

export interface SessionTable {
  id: Generated<string>;
  expiresAt: Date;
  token: string;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

export interface UserTable {
  id: Generated<string>;
  name: string;
  email: string;
  emailVerified: Generated<boolean>;
  image: string | null;
  role: Generated<'god' | 'member'>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  twoFactorEnabled: Generated<boolean>;
  banned: boolean | null;
  ban_source: string | null;
  banned_at: Date | null;
}

export interface VerificationTable {
  id: Generated<string>;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Generated<Date | null>;
  updatedAt: Generated<Date | null>;
}

export interface ZvApiKeyAccessLogTable {
  id: Generated<string>;
  api_key_id: string;
  ip_address: string;
  method: string;
  path: string;
  status_code: number | null;
  duration_ms: number | null;
  created_at: Generated<Date>;
}

export interface ZvApiKeysTable {
  id: Generated<string>;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: Generated<unknown>;
  rate_limit: number | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  is_active: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  allowed_ips: Generated<string[] | null>;
  organization: Generated<string | null>;
  description: Generated<string | null>;
  permissions_mode: Generated<'scoped' | 'casbin' | 'god'>;
  casbin_subject: Generated<string | null>;
  request_count: Generated<number>;
  last_ip: Generated<string | null>;
  tenant_id: Generated<string>;
  rls_bypass: Generated<boolean>;
  member_issued: Generated<boolean>;
}

export interface ZvAuditLogTable {
  id: Generated<string>;
  event_type: string;
  user_id: string | null;
  resource_id: string | null;
  resource_type: string | null;
  metadata: Generated<unknown>;
  ip: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvBackupIntegrityChecksTable {
  id: Generated<string>;
  backup_id: string;
  filename: string;
  size_bytes: number | null;
  checksum_md5: string | null;
  is_valid: boolean | null;
  error: string | null;
  checked_at: Generated<Date>;
}

export interface ZvBackupSchedulesTable {
  id: Generated<string>;
  name: string;
  cron_expression: Generated<string>;
  retention_count: Generated<number>;
  storage_destination: Generated<'local' | 's3' | 'both'>;
  s3_bucket: string | null;
  s3_prefix: string | null;
  notify_on_failure: Generated<boolean>;
  notify_emails: Generated<string[]>;
  is_active: Generated<boolean>;
  last_run_at: Date | null;
  last_run_status: string | null;
  next_run_at: Date | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvBackupUploadsTable {
  id: Generated<string>;
  backup_id: string;
  destination: string;
  s3_bucket: string | null;
  s3_key: string | null;
  size_bytes: number | null;
  status: Generated<'in_progress' | 'completed' | 'failed'>;
  error: string | null;
  created_at: Generated<Date>;
}

export interface ZvBackupsTable {
  id: Generated<string>;
  filename: string;
  size_bytes: number | null;
  status: Generated<'in_progress' | 'completed' | 'failed'>;
  error: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  completed_at: Date | null;
  schedule_id: string | null;
}

export interface ZvDashboardsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  icon: Generated<string>;
  is_default: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  layout: Generated<unknown>;
  is_public: Generated<boolean>;
  tags: Generated<string[]>;
  last_viewed_at: Date | null;
  view_count: Generated<number>;
  tenant_id: Generated<string | null>;
}

export interface ZvDefaultGrantRevocationsTable {
  role: string;
  resource: string;
  action: string;
  revoked_at: Generated<Date>;
}

export interface ZvDefaultGrantRevocationsPruned116Table {
  role: string;
  resource: string;
  action: string;
  revoked_at: Date | null;
  pruned_at: Generated<Date>;
}

export interface ZvDocTemplatesTable {
  id: Generated<string>;
  name: string;
  type: string;
  description: string | null;
  template_html: Generated<string>;
  template_text: string | null;
  variables: Generated<unknown>;
  source_collection: string | null;
  field_mapping: Generated<unknown>;
  prefix: Generated<string>;
  counter: Generated<number>;
  is_active: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvEdgeFunctionLogsTable {
  id: Generated<string>;
  function_id: string;
  status: number;
  duration_ms: number | null;
  request_body: string | null;
  response_body: string | null;
  error: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvEdgeFunctionsTable {
  id: Generated<string>;
  name: string;
  display_name: string;
  description: string | null;
  code: Generated<string>;
  runtime: Generated<string>;
  http_method: Generated<string>;
  path: string;
  is_active: Generated<boolean>;
  timeout_ms: Generated<number>;
  env_vars: Generated<unknown>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
  egress: string[] | null;
}

export interface ZvEnvironmentsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  slug: string;
  schema_name: string | null;
  is_production: Generated<boolean>;
  color: Generated<string | null>;
  settings: Generated<unknown | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvErdLayoutsTable {
  id: Generated<string>;
  user_id: string;
  collection_name: string;
  x: number;
  y: number;
  updated_at: Generated<Date>;
}

export interface ZvExtensionForwardApprovalsTable {
  name: Generated<string>;
  approved: unknown;
  approved_at: Generated<Date>;
}

export interface ZvExtensionRegistryTable {
  id: Generated<string>;
  name: string;
  display_name: string;
  description: string | null;
  category: Generated<string>;
  version: Generated<string>;
  author: string | null;
  is_installed: Generated<boolean>;
  is_enabled: Generated<boolean>;
  config: Generated<unknown>;
  installed_at: Date | null;
  enabled_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: string | null;
  last_load_error: string | null;
  last_load_at: Date | null;
  granted_capabilities: unknown | null;
  installed_sha256: string | null;
  installed_version: string | null;
  approved_forward_credentials: unknown | null;
  manifest: unknown | null;
}

export interface ZvExtensionScheduleRunsTable {
  id: Generated<string>;
  extension_name: string;
  schedule_name: string;
  started_at: Generated<Date>;
  finished_at: Date | null;
  status: string;
  attempt: Generated<number>;
  error_message: string | null;
  trace_id: string | null;
}

export interface ZvFlowDlqTable {
  id: Generated<string>;
  flow_id: string;
  payload: Generated<unknown>;
  error: string | null;
  attempt_count: Generated<number>;
  created_at: Generated<Date>;
}

export interface ZvFlowRunsTable {
  id: Generated<string>;
  flow_id: string;
  status: Generated<'running' | 'success' | 'failed' | 'cancelled'>;
  trigger_data: unknown | null;
  output: unknown | null;
  error: string | null;
  started_at: Generated<Date>;
  finished_at: Date | null;
  event_id: string | null;
}

export interface ZvFlowStepsTable {
  id: Generated<string>;
  flow_id: string;
  step_order: Generated<number>;
  name: string;
  type:
    | 'query_db'
    | 'run_script'
    | 'send_email'
    | 'webhook'
    | 'send_notification'
    | 'export_collection'
    | 'condition';
  config: Generated<unknown>;
  on_error: Generated<'stop' | 'continue' | 'retry'>;
  created_at: Generated<Date>;
}

export interface ZvFlowsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  trigger_type: Generated<'manual' | 'on_create' | 'on_update' | 'on_delete' | 'cron' | 'webhook'>;
  trigger_config: Generated<unknown>;
  is_active: Generated<boolean>;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
  run_as_role: Generated<string | null>;
}

export interface ZvIdentityLinksTable {
  tenant_id: string;
  provider: string;
  subject: string;
  user_id: string;
  active: Generated<boolean>;
  suspended_at: Date | null;
  held_valid_to: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvImportLogsTable {
  id: Generated<string>;
  collection: string;
  filename: string;
  file_format: Generated<'csv' | 'xlsx' | 'json' | 'ndjson'>;
  status: Generated<'pending' | 'processing' | 'completed' | 'failed' | 'partial'>;
  total_rows: Generated<number>;
  processed_rows: Generated<number>;
  success_rows: Generated<number>;
  error_rows: Generated<number>;
  errors: Generated<unknown | null>;
  options: Generated<unknown | null>;
  created_by: string | null;
  created_at: Generated<Date>;
  completed_at: Date | null;
  tenant_id: Generated<string | null>;
  format: Generated<'csv' | 'json' | 'ndjson'>;
  failed_rows: Generated<number>;
  imported_rows: Generated<number>;
}

export interface ZvInstancesTable {
  instance_id: Generated<string>;
  started_at: Generated<Date>;
  last_seen: Generated<Date>;
}

export interface ZvInvitationsTable {
  id: Generated<string>;
  email: string;
  name: string | null;
  role: Generated<string>;
  token: string;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by: string | null;
  invited_by: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string>;
}

export interface ZvLicenseAuditTable {
  id: Generated<string>;
  action: string;
  extension_name: string | null;
  performed_by: string | null;
  performed_at: Generated<Date>;
  ip: string | null;
  user_agent: string | null;
  details: Generated<unknown>;
}

export interface ZvMediaFileTagsTable {
  file_id: string;
  tag_id: string;
  tenant_id: Generated<string | null>;
}

export interface ZvMediaFilesTable {
  id: Generated<string>;
  folder_id: string | null;
  filename: string;
  original_name: string;
  mimetype: string;
  size: Generated<number>;
  storage_path: string;
  url: string | null;
  width: number | null;
  height: number | null;
  metadata: Generated<unknown | null>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  title: string | null;
  description: string | null;
  alt_text: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  deleted_at: Generated<Date | null>;
  deleted_by: string | null;
  restore_folder_id: string | null;
  tenant_id: Generated<string | null>;
  visibility: Generated<'tenant' | 'personal'>;
  created_by_api_key: string | null;
}

export interface ZvMediaFoldersTable {
  id: Generated<string>;
  name: string;
  parent_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  deleted_at: Generated<Date | null>;
  tenant_id: Generated<string | null>;
  updated_at: Generated<Date>;
}

export interface ZvMediaSharesTable {
  id: Generated<string>;
  file_id: string | null;
  folder_id: string | null;
  token: string;
  share_type: Generated<'view' | 'download' | 'edit'>;
  password_hash: string | null;
  expires_at: Date | null;
  max_downloads: number | null;
  download_count: Generated<number>;
  created_by: string;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  tenant_id: Generated<string>;
}

export interface ZvMediaTagsTable {
  id: Generated<string>;
  name: string;
  color: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMediaVersionsTable {
  id: Generated<string>;
  file_id: string;
  version_num: Generated<number>;
  storage_path: string;
  size_bytes: number;
  mime_type: string;
  checksum: string | null;
  uploaded_by: string | null;
  created_at: Generated<Date>;
}

export interface ZvMigrationsTable {
  id: Generated<number>;
  name: string;
  applied_at: Generated<Date>;
  down_sql: string | null;
}

export interface ZvNotificationsTable {
  id: Generated<string>;
  user_id: string;
  title: string;
  message: string;
  type: Generated<'info' | 'success' | 'warning' | 'error'>;
  action_url: string | null;
  is_read: Generated<boolean>;
  source: string | null;
  metadata: Generated<unknown | null>;
  created_at: Generated<Date>;
}

export interface ZvPanelsTable {
  id: Generated<string>;
  dashboard_id: string;
  name: string | null;
  type: Generated<string>;
  query: Generated<string>;
  config: Generated<unknown>;
  position_x: Generated<number>;
  position_y: Generated<number>;
  width: Generated<number>;
  height: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  title: string;
  position: Generated<unknown>;
  refresh_interval: number | null;
  last_executed_at: Date | null;
  avg_execution_ms: number | null;
  error_count: Generated<number>;
}

export interface ZvPitrConfigTable {
  id: Generated<string>;
  is_enabled: Generated<boolean>;
  wal_archive_path: string | null;
  retention_days: Generated<number>;
  last_base_backup_at: Date | null;
  last_wal_segment: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvPitrRestorePointsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  lsn: string | null;
  recorded_at: Generated<Date>;
  created_by: string | null;
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

export interface ZvRateLimitConfigsTable {
  id: Generated<string>;
  key_prefix: string;
  window_ms: Generated<number>;
  max_requests: Generated<number>;
  is_active: Generated<boolean>;
  description: string | null;
  updated_by: string | null;
  updated_at: Generated<Date>;
}

export interface ZvRecordCommentsTable {
  id: Generated<string>;
  collection: string;
  record_id: string;
  comment: string;
  user_id: string | null;
  parent_id: string | null;
  is_resolved: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvRevisionsTable {
  id: Generated<string>;
  collection: string;
  record_id: string;
  action: 'create' | 'update' | 'delete';
  data: Generated<unknown>;
  delta: unknown | null;
  user_id: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvRolesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  created_at: Generated<Date>;
}

export interface ZvSavedQueriesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  collection: string;
  config: Generated<unknown>;
  is_shared: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvSchemaBranchesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  base_schema: Generated<string>;
  branch_schema: string;
  status: Generated<'open' | 'merged' | 'closed'>;
  changes: Generated<unknown>;
  created_by: string | null;
  merged_by: string | null;
  merged_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  review_status: Generated<'pending' | 'approved' | 'changes_requested' | 'rejected' | null>;
  review_requested_by: string | null;
  labels: Generated<string[]>;
  preview_enabled: Generated<boolean>;
  preview_token: string | null;
  preview_schema: string | null;
  preview_enabled_at: Date | null;
  preview_expires_at: Date | null;
  preview_token_rotated_at: Date | null;
  requires_approval: Generated<boolean>;
}

export interface ZvSchemaMigrationsTable {
  id: Generated<string>;
  checksum: string;
  applied_at: Generated<Date>;
  applied_by: string | null;
}

export interface ZvSchemaVersionsTable {
  id: Generated<number>;
  version: number;
  name: string;
  filename: string;
  checksum: string;
  applied_at: Generated<Date>;
  engine_version: string | null;
  execution_ms: number | null;
  rolled_back_at: Date | null;
}

export interface ZvSettingsTable {
  key: Generated<string>;
  value: unknown;
  description: string | null;
  is_public: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvSlowQueriesTable {
  id: Generated<string>;
  method: string;
  path: string;
  query_params: Generated<unknown | null>;
  status_code: number | null;
  duration_ms: number;
  created_at: Generated<Date>;
}

export interface ZvStorageQuotasTable {
  user_id: Generated<string>;
  quota_bytes: Generated<number>;
  used_bytes: Generated<number>;
  updated_at: Generated<Date>;
}

export interface ZvSyncTombstonesTable {
  tenant_id: string;
  collection: string;
  row_id: string;
  deleted_at: Generated<Date>;
}

export interface ZvTenantTransfersTable {
  id: Generated<string>;
  table_name: string;
  record_id: string;
  from_tenant: string;
  to_tenant: string;
  moved_at: Generated<Date>;
  moved_by: string | null;
  reason: string | null;
}

export interface ZvTenantUsersTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  role: Generated<'owner' | 'admin' | 'member' | 'viewer'>;
  invited_by: string | null;
  joined_at: Generated<Date>;
  read_scope: Generated<'self' | 'subtree' | 'list' | 'org'>;
  scope_list: string[] | null;
  valid_from: Generated<Date>;
  valid_to: Date | null;
}

export interface ZvTenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  status: Generated<'active' | 'suspended' | 'deleted'>;
  settings: Generated<unknown | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  parent_id: string | null;
  closed_at: Date | null;
  merged_into: string | null;
}

export interface ZvValidationRulesTable {
  id: Generated<string>;
  collection: string;
  field_name: string;
  rule_type: string;
  nl_description: string | null;
  rule_config: Generated<unknown>;
  error_message: string;
  is_active: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: string | null;
}

export interface ZvdBranchReviewRequestsTable {
  id: Generated<string>;
  branch_id: string;
  requested_by: string;
  reviewer_id: string | null;
  status: Generated<'pending' | 'approved' | 'changes_requested' | 'rejected'>;
  message: string | null;
  reviewer_note: string | null;
  reviewed_at: Date | null;
  created_at: Generated<Date>;
}

export interface ZvdCollectionsTable {
  id: Generated<string>;
  name: string;
  display_name: string | null;
  icon: Generated<string | null>;
  route_group: Generated<'public' | 'partners' | 'private' | 'admin' | null>;
  is_permissioned: Generated<boolean | null>;
  sort: Generated<number | null>;
  singular_name: string | null;
  description: string | null;
  fields: Generated<unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  source_type: Generated<'table' | 'virtual'>;
  virtual_config: unknown | null;
  is_managed: Generated<boolean>;
  is_system: Generated<boolean>;
  schema_locked: Generated<boolean>;
  has_trgm: Generated<boolean>;
  owner_extension: string | null;
  declared_file: unknown | null;
  default_grants: Generated<boolean>;
  written_by: string | null;
}

export interface ZvdColumnPermissionsTable {
  id: Generated<string>;
  collection_name: string;
  column_name: string;
  role: string;
  can_read: Generated<boolean>;
  can_write: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdDashboardSharesTable {
  id: Generated<string>;
  dashboard_id: string;
  shared_with_user_id: string | null;
  shared_with_role: string | null;
  permission: Generated<'view' | 'edit'>;
  created_by: string;
  created_at: Generated<Date>;
}

export interface ZvdDashboardSubscriptionsTable {
  id: Generated<string>;
  dashboard_id: string;
  user_id: string;
  email: string;
  frequency: Generated<'daily' | 'weekly' | 'monthly'>;
  day_of_week: number | null;
  hour_of_day: Generated<number>;
  last_sent_at: Date | null;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface ZvdInsightSavedQueriesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  query: string;
  tags: Generated<string[]>;
  is_public: Generated<boolean>;
  use_count: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string>;
}

export interface ZvdPanelCacheTable {
  id: Generated<string>;
  panel_id: string;
  result: Generated<unknown>;
  row_count: Generated<number>;
  executed_at: Generated<Date>;
  expires_at: Generated<Date>;
  execution_ms: Generated<number>;
}

export interface ZvdPermissionsTable {
  id: Generated<string>;
  ptype: string;
  v0: string | null;
  v1: string | null;
  v2: string | null;
  v3: string | null;
  v4: string | null;
  v5: string | null;
  created_at: Generated<Date>;
}

export interface ZvdPermissionsPruned012Table {
  id: Generated<string>;
  ptype: string;
  v0: string | null;
  v1: string | null;
  v2: string | null;
  v3: string | null;
  v4: string | null;
  v5: string | null;
  created_at: Date | null;
  membership: string | null;
  pruned_at: Generated<Date>;
}

export interface ZvdPermissionsPruned033Table {
  id: Generated<string>;
  ptype: string;
  v0: string | null;
  v1: string | null;
  v2: string | null;
  v3: string | null;
  v4: string | null;
  v5: string | null;
  created_at: Date | null;
  column_role: string | null;
  pruned_at: Generated<Date>;
}

export interface ZvdPermissionsPruned034Table {
  id: Generated<string>;
  ptype: string;
  v0: string | null;
  v1: string | null;
  v2: string | null;
  v3: string | null;
  v4: string | null;
  v5: string | null;
  created_at: Date | null;
  pruned_at: Generated<Date>;
}

export interface ZvdPermissionsPruned116Table {
  id: Generated<string>;
  ptype: string;
  v0: string | null;
  v1: string | null;
  v2: string | null;
  v3: string | null;
  v4: string | null;
  v5: string | null;
  created_at: Date | null;
  pruned_at: Generated<Date>;
}

export interface ZvdPushTokensTable {
  id: Generated<string>;
  user_id: string;
  token: string;
  platform: 'fcm' | 'apns' | 'web';
  device_name: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdPushTokensSuperseded013Table {
  id: Generated<string>;
  user_id: string;
  token: string;
  platform: string;
  device_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ZvdRelationsTable {
  id: Generated<string>;
  name: string;
  type: 'm2o' | 'o2m' | 'm2m' | 'm2a';
  source_collection: string;
  source_field: string;
  target_collection: string;
  target_field: string | null;
  junction_table: string | null;
  foreign_key_constraint: string | null;
  on_delete: Generated<'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' | null>;
  on_update: Generated<'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' | null>;
  metadata: Generated<unknown | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdRlsPoliciesTable {
  id: Generated<string>;
  collection: string;
  role: string;
  filter_field: string;
  filter_op: Generated<string>;
  filter_value_source: string;
  is_enabled: Generated<boolean>;
  description: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdRpcFunctionsTable {
  id: Generated<string>;
  function_name: string;
  description: string | null;
  required_role: Generated<string>;
  is_enabled: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface ZvdValidationImportLogTable {
  id: Generated<string>;
  collection: string;
  imported_count: Generated<number>;
  failed_count: Generated<number>;
  errors: Generated<unknown>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdValidationRuleGroupsTable {
  id: Generated<string>;
  name: string;
  collection: string;
  field_name: string;
  description: string | null;
  logic: Generated<'AND' | 'OR'>;
  rule_ids: Generated<string[]>;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
}

export interface ZvdValidationTestCasesTable {
  id: Generated<string>;
  rule_id: string;
  label: string;
  input_value: string;
  previous_value: string | null;
  expected_result: boolean;
  last_run_result: boolean | null;
  last_run_at: Date | null;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdWebhookDeliveriesTable {
  id: Generated<string>;
  webhook_id: string;
  payload: unknown;
  url: string;
  method: string;
  headers: Generated<unknown | null>;
  attempt: Generated<number>;
  max_attempts: Generated<number>;
  status: number | null;
  response_body: string | null;
  error: string | null;
  delivered_at: Date | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
  event_id: string | null;
}

export interface ZvdWebhooksTable {
  id: Generated<string>;
  name: string;
  url: string;
  method: Generated<'POST' | 'PUT' | 'PATCH' | null>;
  headers: Generated<unknown | null>;
  events: string[];
  collections: string[] | null;
  active: Generated<boolean | null>;
  secret: string | null;
  retry_attempts: Generated<number | null>;
  timeout: Generated<number | null>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
  run_as_role: Generated<string | null>;
}

export interface DbSchema {
  account: AccountTable;
  session: SessionTable;
  user: UserTable;
  verification: VerificationTable;
  zv_api_key_access_log: ZvApiKeyAccessLogTable;
  zv_api_keys: ZvApiKeysTable;
  zv_audit_log: ZvAuditLogTable;
  zv_backup_integrity_checks: ZvBackupIntegrityChecksTable;
  zv_backup_schedules: ZvBackupSchedulesTable;
  zv_backup_uploads: ZvBackupUploadsTable;
  zv_backups: ZvBackupsTable;
  zv_dashboards: ZvDashboardsTable;
  zv_default_grant_revocations: ZvDefaultGrantRevocationsTable;
  zv_default_grant_revocations_pruned_116: ZvDefaultGrantRevocationsPruned116Table;
  zv_doc_templates: ZvDocTemplatesTable;
  zv_edge_function_logs: ZvEdgeFunctionLogsTable;
  zv_edge_functions: ZvEdgeFunctionsTable;
  zv_environments: ZvEnvironmentsTable;
  zv_erd_layouts: ZvErdLayoutsTable;
  zv_extension_forward_approvals: ZvExtensionForwardApprovalsTable;
  zv_extension_registry: ZvExtensionRegistryTable;
  zv_extension_schedule_runs: ZvExtensionScheduleRunsTable;
  zv_flow_dlq: ZvFlowDlqTable;
  zv_flow_runs: ZvFlowRunsTable;
  zv_flow_steps: ZvFlowStepsTable;
  zv_flows: ZvFlowsTable;
  zv_identity_links: ZvIdentityLinksTable;
  zv_import_logs: ZvImportLogsTable;
  zv_instances: ZvInstancesTable;
  zv_invitations: ZvInvitationsTable;
  zv_license_audit: ZvLicenseAuditTable;
  zv_media_file_tags: ZvMediaFileTagsTable;
  zv_media_files: ZvMediaFilesTable;
  zv_media_folders: ZvMediaFoldersTable;
  zv_media_shares: ZvMediaSharesTable;
  zv_media_tags: ZvMediaTagsTable;
  zv_media_versions: ZvMediaVersionsTable;
  zv_migrations: ZvMigrationsTable;
  zv_notifications: ZvNotificationsTable;
  zv_panels: ZvPanelsTable;
  zv_pitr_config: ZvPitrConfigTable;
  zv_pitr_restore_points: ZvPitrRestorePointsTable;
  zv_push_subscriptions: ZvPushSubscriptionsTable;
  zv_rate_limit_configs: ZvRateLimitConfigsTable;
  zv_record_comments: ZvRecordCommentsTable;
  zv_request_logs: ZvRequestLogsTable;
  zv_revisions: ZvRevisionsTable;
  zv_roles: ZvRolesTable;
  zv_saved_queries: ZvSavedQueriesTable;
  zv_schema_branches: ZvSchemaBranchesTable;
  zv_schema_migrations: ZvSchemaMigrationsTable;
  zv_schema_versions: ZvSchemaVersionsTable;
  zv_settings: ZvSettingsTable;
  zv_slow_queries: ZvSlowQueriesTable;
  zv_storage_quotas: ZvStorageQuotasTable;
  zv_sync_tombstones: ZvSyncTombstonesTable;
  zv_tenant_transfers: ZvTenantTransfersTable;
  zv_tenant_users: ZvTenantUsersTable;
  zv_tenants: ZvTenantsTable;
  zv_validation_rules: ZvValidationRulesTable;
  zvd_branch_review_requests: ZvdBranchReviewRequestsTable;
  zvd_collections: ZvdCollectionsTable;
  zvd_column_permissions: ZvdColumnPermissionsTable;
  zvd_dashboard_shares: ZvdDashboardSharesTable;
  zvd_dashboard_subscriptions: ZvdDashboardSubscriptionsTable;
  zvd_insight_saved_queries: ZvdInsightSavedQueriesTable;
  zvd_panel_cache: ZvdPanelCacheTable;
  zvd_permissions: ZvdPermissionsTable;
  zvd_permissions_pruned_012: ZvdPermissionsPruned012Table;
  zvd_permissions_pruned_033: ZvdPermissionsPruned033Table;
  zvd_permissions_pruned_034: ZvdPermissionsPruned034Table;
  zvd_permissions_pruned_116: ZvdPermissionsPruned116Table;
  zvd_push_tokens: ZvdPushTokensTable;
  zvd_push_tokens_superseded_013: ZvdPushTokensSuperseded013Table;
  zvd_relations: ZvdRelationsTable;
  zvd_rls_policies: ZvdRlsPoliciesTable;
  zvd_rpc_functions: ZvdRpcFunctionsTable;
  zvd_validation_import_log: ZvdValidationImportLogTable;
  zvd_validation_rule_groups: ZvdValidationRuleGroupsTable;
  zvd_validation_test_cases: ZvdValidationTestCasesTable;
  zvd_webhook_deliveries: ZvdWebhookDeliveriesTable;
  zvd_webhooks: ZvdWebhooksTable;
}
