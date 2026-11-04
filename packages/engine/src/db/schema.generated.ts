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

export interface ZvAiChatsTable {
  id: Generated<string>;
  title: string | null;
  user_id: string;
  provider: Generated<string>;
  model: string | null;
  context: string | null;
  messages: Generated<unknown>;
  metadata: Generated<unknown | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvAiConversationsTable {
  id: Generated<string>;
  user_id: string;
  title: string | null;
  metadata: Generated<unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvAiFeaturesTable {
  id: Generated<string>;
  feature_key: string;
  display_name: string;
  description: string | null;
  is_enabled: Generated<boolean>;
  config: Generated<unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvAiMemoryTable {
  id: Generated<string>;
  user_id: string;
  context_key: string;
  content: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  importance: Generated<number>;
  source: Generated<string>;
  embedding: unknown | null;
  tenant_id: Generated<string | null>;
}

export interface ZvAiMessagesTable {
  id: Generated<string>;
  conversation_id: string;
  user_id: string | null;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  metadata: Generated<unknown>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvAiProvidersTable {
  id: Generated<string>;
  name: string;
  label: string;
  api_key: string | null;
  base_url: string | null;
  default_model: string | null;
  is_active: Generated<boolean>;
  is_default: Generated<boolean>;
  metadata: Generated<unknown | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvAiQueriesTable {
  id: Generated<string>;
  user_id: string;
  prompt: string;
  generated_sql: string | null;
  result_count: number | null;
  execution_ms: number | null;
  ai_analysis: string | null;
  chart_config: unknown | null;
  is_saved: Generated<boolean>;
  title: string | null;
  error: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvAiUsageTable {
  id: Generated<string>;
  provider: string;
  model: string;
  operation: 'chat' | 'embed' | 'query' | 'generate' | 'decide';
  prompt_tokens: Generated<number>;
  response_tokens: Generated<number>;
  latency_ms: Generated<number>;
  user_id: string | null;
  tenant_id: Generated<string | null>;
  created_at: Generated<Date>;
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

export interface ZvCloudAccessLogsTable {
  id: Generated<string>;
  file_id: string;
  user_id: string | null;
  ip: string | null;
  action: 'view' | 'download' | 'upload' | 'delete' | 'share' | 'version';
  share_token: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvCloudFileVersionsTable {
  id: Generated<string>;
  file_key: string;
  bucket: Generated<string>;
  version: Generated<number>;
  size: Generated<number>;
  content_type: string | null;
  etag: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvCloudRetentionPoliciesTable {
  id: Generated<string>;
  name: string;
  folder_path: string | null;
  file_extension: string | null;
  max_versions: Generated<number>;
  delete_after_days: number | null;
  archive_after_days: number | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvCloudSharesTable {
  id: Generated<string>;
  token: Generated<string>;
  file_key: string;
  bucket: Generated<string>;
  filename: string | null;
  content_type: string | null;
  password_hash: string | null;
  max_downloads: number | null;
  download_count: Generated<number>;
  expires_at: Date | null;
  created_by: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvCloudTrashTable {
  id: Generated<string>;
  file_key: string;
  original_path: string;
  bucket: Generated<string>;
  size: Generated<number>;
  content_type: string | null;
  deleted_by: string | null;
  deleted_at: Generated<Date>;
  purge_after: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvEfacturaDailyStatsTable {
  date: Date;
  seller_cui: string;
  submitted_count: Generated<number>;
  accepted_count: Generated<number>;
  rejected_count: Generated<number>;
  total_amount: Generated<number>;
  vat_amount: Generated<number>;
  tenant_id: Generated<string>;
}

export interface ZvEfacturaInvoicesTable {
  id: Generated<string>;
  invoice_number: string | null;
  invoice_date: Date | null;
  due_date: Date | null;
  seller_name: string;
  seller_cui: string;
  seller_reg_com: string | null;
  seller_address: string | null;
  seller_iban: string | null;
  seller_bank: string | null;
  buyer_name: string;
  buyer_cui: string | null;
  buyer_address: string | null;
  lines: Generated<unknown>;
  subtotal: Generated<number>;
  vat_total: Generated<number>;
  total: Generated<number>;
  currency: Generated<string>;
  status: Generated<string>;
  xml_content: string | null;
  anaf_index: string | null;
  anaf_response: unknown | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  buyer_cui_type: Generated<'RO' | 'EU' | 'OTHER' | null>;
  payment_method: string | null;
  payment_reference: string | null;
  reverse_charge: Generated<boolean>;
  created_by: string | null;
  source_invoice_id: string | null;
  tenant_id: Generated<string | null>;
  seller_city: string | null;
  seller_country: Generated<string | null>;
  buyer_city: string | null;
  buyer_country: Generated<string | null>;
  seller_county: string | null;
  buyer_county: string | null;
}

export interface ZvEfacturaSettingsTable {
  id: Generated<string>;
  environment: Generated<'test' | 'prod'>;
  seller_cif: string | null;
  client_id: string | null;
  client_secret: string | null;
  cert_path: string | null;
  cert_password: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: Date | null;
  last_verified_at: Date | null;
  last_error: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
  callback_url: string | null;
}

export interface ZvEfacturaStatusLogTable {
  id: Generated<string>;
  invoice_id: string;
  old_status: string;
  new_status: string;
  changed_by: string;
  note: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvEfacturaStornoTable {
  id: Generated<string>;
  original_id: string;
  storno_invoice_id: string | null;
  reason: string;
  requested_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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
    | 'ai_decision'
    | 'condition';
  config: Generated<unknown>;
  on_error: Generated<'stop' | 'continue' | 'retry'>;
  created_at: Generated<Date>;
}

export interface ZvFlowsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  trigger_type: Generated<
    'manual' | 'on_create' | 'on_update' | 'on_delete' | 'cron' | 'webhook' | 'ai_task'
  >;
  trigger_config: Generated<unknown>;
  is_active: Generated<boolean>;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvMailAccountsTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  email_address: string;
  display_name: string | null;
  imap_host: string;
  imap_port: Generated<number>;
  imap_secure: Generated<boolean>;
  imap_user: string;
  imap_password: string;
  imap_idle_supported: Generated<boolean | null>;
  smtp_host: string;
  smtp_port: Generated<number>;
  smtp_secure: Generated<boolean>;
  smtp_user: string | null;
  smtp_password: string | null;
  sieve_host: Generated<string | null>;
  sieve_port: Generated<number | null>;
  oauth2_provider: Generated<'gmail' | 'outlook' | null>;
  oauth2_access_token: Generated<string | null>;
  oauth2_refresh_token: Generated<string | null>;
  oauth2_expires_at: Generated<Date | null>;
  is_default: Generated<boolean>;
  is_active: Generated<boolean>;
  last_sync_at: Date | null;
  sync_error: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMailAttachmentsTable {
  id: Generated<string>;
  message_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  content_id: string | null;
  is_inline: Generated<boolean>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
  part: string | null;
}

export interface ZvMailContactsTable {
  id: Generated<string>;
  user_id: string;
  email: string;
  display_name: string | null;
  company: string | null;
  phone: string | null;
  frequency: Generated<number>;
  last_used_at: Date | null;
  source: Generated<'auto' | 'manual' | 'import' | null>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMailDraftsTable {
  id: Generated<string>;
  account_id: string;
  identity_id: string | null;
  to_addresses: Generated<unknown>;
  cc_addresses: Generated<unknown>;
  bcc_addresses: Generated<unknown>;
  subject: Generated<string>;
  body_html: Generated<string>;
  body_text: Generated<string>;
  in_reply_to: string | null;
  references_hdr: string | null;
  reply_type: 'reply' | 'reply_all' | 'forward' | null;
  original_msg_id: string | null;
  attachments: Generated<unknown>;
  priority: Generated<'high' | 'normal' | 'low' | null>;
  request_read_receipt: Generated<boolean>;
  imap_uid: number | null;
  auto_saved_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMailFiltersTable {
  id: Generated<string>;
  account_id: string;
  name: string;
  is_active: Generated<boolean>;
  sort_order: Generated<number>;
  conditions: Generated<unknown>;
  actions: Generated<unknown>;
  sieve_script: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMailFoldersTable {
  id: Generated<string>;
  account_id: string;
  name: string;
  path: string;
  type: Generated<'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'other' | null>;
  unread_count: Generated<number>;
  total_count: Generated<number>;
  last_uid: Generated<number | null>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMailIdentitiesTable {
  id: Generated<string>;
  account_id: string;
  email_address: string;
  display_name: string | null;
  reply_to: string | null;
  bcc_self: Generated<boolean>;
  is_default: Generated<boolean>;
  sort_order: Generated<number>;
  signature_id: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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
  to_addresses: Generated<unknown>;
  cc_addresses: Generated<unknown>;
  bcc_addresses: Generated<unknown>;
  reply_to: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  snippet: string | null;
  priority: Generated<'high' | 'normal' | 'low' | null>;
  is_read: Generated<boolean>;
  is_starred: Generated<boolean>;
  is_draft: Generated<boolean>;
  has_attachments: Generated<boolean>;
  is_encrypted: Generated<boolean>;
  is_signed: Generated<boolean>;
  read_receipt_requested: Generated<boolean>;
  read_receipt_sent: Generated<boolean>;
  tags: Generated<string[] | null>;
  raw_headers: Generated<unknown | null>;
  sent_at: Date | null;
  received_at: Generated<Date>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMailOauthStatesTable {
  state: Generated<string>;
  tenant_id: Generated<string>;
  user_id: string;
  account_id: string;
  provider: 'gmail' | 'outlook';
  redirect_uri: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

export interface ZvMailPgpKeysTable {
  id: Generated<string>;
  user_id: string;
  email: string;
  public_key: string;
  private_key: string | null;
  fingerprint: string;
  is_own: Generated<boolean>;
  expires_at: Date | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMailSignaturesTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  body_html: Generated<string>;
  body_text: Generated<string>;
  is_default: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMediaFavoritesTable {
  user_id: string;
  file_id: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvMigratorConnectionsTable {
  id: Generated<string>;
  source: 'hubspot' | 'notion' | 'airtable';
  name: string;
  token_enc: string;
  created_by: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMigratorRunsTable {
  id: Generated<string>;
  connection_id: string | null;
  source: string;
  source_object: string;
  target_collection: string;
  status: Generated<'running' | 'completed' | 'failed'>;
  total_rows: Generated<number>;
  imported_rows: Generated<number>;
  error: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  completed_at: Date | null;
  tenant_id: Generated<string | null>;
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

export interface ZvPromptTemplatesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  system_prompt: string;
  user_template: string | null;
  variables: Generated<unknown | null>;
  category: Generated<string | null>;
  provider: string | null;
  model: string | null;
  temperature: Generated<number | null>;
  max_tokens: Generated<number | null>;
  is_active: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvRagDocumentsTable {
  id: Generated<string>;
  title: string;
  content: string;
  chunk_index: Generated<number>;
  source_url: string | null;
  source_type: Generated<string | null>;
  collection: string | null;
  record_id: string | null;
  namespace: Generated<string | null>;
  metadata: Generated<unknown | null>;
  created_by: string | null;
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

export interface ZvScimTokensTable {
  id: Generated<string>;
  name: string;
  token_hash: string;
  created_by: string | null;
  created_at: Generated<Date>;
  last_used_at: Date | null;
  tenant_id: Generated<string>;
}

export interface ZvScimUsersTable {
  user_id: Generated<string>;
  external_id: string | null;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string>;
  suspended_at: Date | null;
  held_valid_to: Date | null;
}

export interface ZvSearchIndexesTable {
  id: Generated<string>;
  collection: string;
  provider: Generated<string>;
  index_name: string;
  searchable_fields: Generated<string[]>;
  filterable_fields: Generated<string[]>;
  sortable_fields: Generated<string[]>;
  last_synced_at: Date | null;
  record_count: Generated<number | null>;
  status: Generated<string>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvSmsMessagesTable {
  id: Generated<string>;
  provider: Generated<string>;
  to_number: string;
  from_number: string | null;
  body: string;
  status: Generated<string>;
  provider_message_id: string | null;
  error: string | null;
  metadata: Generated<unknown | null>;
  sent_at: Date | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvSmsTemplatesTable {
  id: Generated<string>;
  name: string;
  body: string;
  provider: Generated<string>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvStorageQuotasTable {
  user_id: Generated<string>;
  quota_bytes: Generated<number>;
  used_bytes: Generated<number>;
  updated_at: Generated<Date>;
  id: Generated<string | null>;
  role_name: string | null;
  max_file_size_bytes: Generated<number>;
  allowed_extensions: Generated<string[]>;
  created_by: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvdAiEmbeddingsTable {
  id: Generated<string>;
  collection: string;
  record_id: string;
  field: Generated<string>;
  text_content: Generated<string>;
  embedding: unknown | null;
  model: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdAiSearchConfigTable {
  id: Generated<string>;
  collection: string;
  fields: Generated<string[]>;
  namespace: Generated<string>;
  is_enabled: Generated<boolean>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdApiConnectionsTable {
  id: Generated<string>;
  name: string;
  base_url: string;
  auth_type: Generated<'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2'>;
  auth_config: Generated<unknown>;
  headers: Generated<unknown>;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  default_headers: Generated<unknown>;
  retry_count: Generated<number>;
  timeout_ms: Generated<number>;
  tenant_id: Generated<string | null>;
}

export interface ZvdApiEndpointsTable {
  id: Generated<string>;
  connection_id: string;
  name: string;
  method: Generated<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>;
  path: string;
  description: string | null;
  request_body_template: unknown | null;
  response_mapping: unknown | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  default_body: string | null;
  default_headers: Generated<unknown>;
  tenant_id: Generated<string | null>;
}

export interface ZvdApiLogsTable {
  id: Generated<string>;
  endpoint_id: string;
  status_code: number | null;
  request_body: unknown | null;
  response_body: unknown | null;
  duration_ms: number | null;
  error: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  user_id: string | null;
  url: string | null;
  method: string | null;
  response_status: number | null;
  error_message: string | null;
  retry_count: Generated<number>;
  tenant_id: Generated<string | null>;
}

export interface ZvdApiOauthTokensTable {
  id: Generated<string>;
  connection_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: Date | null;
  token_type: Generated<string>;
  scope: string | null;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvdByodScanHistoryTable {
  id: Generated<string>;
  profile_id: string | null;
  schema_name: string;
  tables_found: Generated<number>;
  tables_imported: Generated<number>;
  tables_updated: Generated<number>;
  tables_skipped: Generated<number>;
  status: Generated<'completed' | 'failed'>;
  error: string | null;
  triggered_by: Generated<string>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdByodScanProfilesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  db_schema: Generated<string>;
  exclude_patterns: Generated<string[]>;
  auto_sync: Generated<boolean>;
  sync_interval_hours: Generated<number>;
  last_sync_at: Date | null;
  next_sync_at: Date | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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
  ai_search_enabled: Generated<boolean>;
  ai_search_field: Generated<string | null>;
  ai_embed_excluded_fields: Generated<string[]>;
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

export interface ZvdIncomingWebhooksTable {
  id: Generated<string>;
  connection_id: string | null;
  name: string;
  secret: string | null;
  endpoint_path: string;
  description: string | null;
  is_active: Generated<boolean>;
  last_received_at: Date | null;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvdLdapConfigTable {
  tenant_id: Generated<string>;
  config: unknown;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdLdapGroupMappingsTable {
  id: Generated<string>;
  ldap_group: string;
  zveltio_role: string;
  description: string | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdLdapIpAllowlistTable {
  id: Generated<string>;
  cidr: string;
  description: string | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdLdapLoginLogTable {
  id: Generated<string>;
  user_id: string | null;
  ldap_dn: string | null;
  username: string;
  ip: string | null;
  success: boolean;
  failure_reason: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdMailConfigTable {
  tenant_id: Generated<string>;
  config: unknown;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
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

export interface ZvdSamlAttributeMappingsTable {
  id: Generated<string>;
  saml_attribute: string;
  zveltio_field: string;
  transform: string | null;
  description: string | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdSamlConfigTable {
  tenant_id: Generated<string>;
  config: unknown;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdSamlConsumedAssertionsTable {
  tenant_id: Generated<string>;
  assertion_id: string;
  consumed_at: Generated<Date>;
  expires_at: Date;
}

export interface ZvdSamlIdpMetadataTable {
  id: Generated<string>;
  entity_id: string;
  metadata_xml: string;
  valid_until: Date | null;
  fetched_at: Generated<Date>;
  refresh_url: string | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdSamlLoginLogTable {
  id: Generated<string>;
  user_id: string | null;
  email: string | null;
  name_id: string | null;
  idp_entity_id: string | null;
  session_index: string | null;
  ip: string | null;
  success: boolean;
  failure_reason: string | null;
  relay_state: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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
}

export interface ZvdWebhookEventsTable {
  id: Generated<string>;
  webhook_id: string;
  payload: Generated<unknown>;
  headers: Generated<unknown>;
  source_ip: string | null;
  status: Generated<'received' | 'processed' | 'failed'>;
  error: string | null;
  received_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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
}

export interface DbSchema {
  account: AccountTable;
  session: SessionTable;
  user: UserTable;
  verification: VerificationTable;
  zv_ai_chats: ZvAiChatsTable;
  zv_ai_conversations: ZvAiConversationsTable;
  zv_ai_features: ZvAiFeaturesTable;
  zv_ai_memory: ZvAiMemoryTable;
  zv_ai_messages: ZvAiMessagesTable;
  zv_ai_providers: ZvAiProvidersTable;
  zv_ai_queries: ZvAiQueriesTable;
  zv_ai_usage: ZvAiUsageTable;
  zv_api_key_access_log: ZvApiKeyAccessLogTable;
  zv_api_keys: ZvApiKeysTable;
  zv_audit_log: ZvAuditLogTable;
  zv_backup_integrity_checks: ZvBackupIntegrityChecksTable;
  zv_backup_schedules: ZvBackupSchedulesTable;
  zv_backup_uploads: ZvBackupUploadsTable;
  zv_backups: ZvBackupsTable;
  zv_cloud_access_logs: ZvCloudAccessLogsTable;
  zv_cloud_file_versions: ZvCloudFileVersionsTable;
  zv_cloud_retention_policies: ZvCloudRetentionPoliciesTable;
  zv_cloud_shares: ZvCloudSharesTable;
  zv_cloud_trash: ZvCloudTrashTable;
  zv_dashboards: ZvDashboardsTable;
  zv_default_grant_revocations: ZvDefaultGrantRevocationsTable;
  zv_doc_templates: ZvDocTemplatesTable;
  zv_edge_function_logs: ZvEdgeFunctionLogsTable;
  zv_edge_functions: ZvEdgeFunctionsTable;
  zv_efactura_daily_stats: ZvEfacturaDailyStatsTable;
  zv_efactura_invoices: ZvEfacturaInvoicesTable;
  zv_efactura_settings: ZvEfacturaSettingsTable;
  zv_efactura_status_log: ZvEfacturaStatusLogTable;
  zv_efactura_storno: ZvEfacturaStornoTable;
  zv_environments: ZvEnvironmentsTable;
  zv_erd_layouts: ZvErdLayoutsTable;
  zv_extension_forward_approvals: ZvExtensionForwardApprovalsTable;
  zv_extension_registry: ZvExtensionRegistryTable;
  zv_extension_schedule_runs: ZvExtensionScheduleRunsTable;
  zv_flow_dlq: ZvFlowDlqTable;
  zv_flow_runs: ZvFlowRunsTable;
  zv_flow_steps: ZvFlowStepsTable;
  zv_flows: ZvFlowsTable;
  zv_import_logs: ZvImportLogsTable;
  zv_instances: ZvInstancesTable;
  zv_invitations: ZvInvitationsTable;
  zv_license_audit: ZvLicenseAuditTable;
  zv_mail_accounts: ZvMailAccountsTable;
  zv_mail_attachments: ZvMailAttachmentsTable;
  zv_mail_contacts: ZvMailContactsTable;
  zv_mail_drafts: ZvMailDraftsTable;
  zv_mail_filters: ZvMailFiltersTable;
  zv_mail_folders: ZvMailFoldersTable;
  zv_mail_identities: ZvMailIdentitiesTable;
  zv_mail_messages: ZvMailMessagesTable;
  zv_mail_oauth_states: ZvMailOauthStatesTable;
  zv_mail_pgp_keys: ZvMailPgpKeysTable;
  zv_mail_signatures: ZvMailSignaturesTable;
  zv_media_favorites: ZvMediaFavoritesTable;
  zv_media_file_tags: ZvMediaFileTagsTable;
  zv_media_files: ZvMediaFilesTable;
  zv_media_folders: ZvMediaFoldersTable;
  zv_media_shares: ZvMediaSharesTable;
  zv_media_tags: ZvMediaTagsTable;
  zv_media_versions: ZvMediaVersionsTable;
  zv_migrations: ZvMigrationsTable;
  zv_migrator_connections: ZvMigratorConnectionsTable;
  zv_migrator_runs: ZvMigratorRunsTable;
  zv_notifications: ZvNotificationsTable;
  zv_panels: ZvPanelsTable;
  zv_pitr_config: ZvPitrConfigTable;
  zv_pitr_restore_points: ZvPitrRestorePointsTable;
  zv_prompt_templates: ZvPromptTemplatesTable;
  zv_push_subscriptions: ZvPushSubscriptionsTable;
  zv_rag_documents: ZvRagDocumentsTable;
  zv_rate_limit_configs: ZvRateLimitConfigsTable;
  zv_record_comments: ZvRecordCommentsTable;
  zv_request_logs: ZvRequestLogsTable;
  zv_revisions: ZvRevisionsTable;
  zv_roles: ZvRolesTable;
  zv_saved_queries: ZvSavedQueriesTable;
  zv_schema_branches: ZvSchemaBranchesTable;
  zv_schema_migrations: ZvSchemaMigrationsTable;
  zv_schema_versions: ZvSchemaVersionsTable;
  zv_scim_tokens: ZvScimTokensTable;
  zv_scim_users: ZvScimUsersTable;
  zv_search_indexes: ZvSearchIndexesTable;
  zv_settings: ZvSettingsTable;
  zv_slow_queries: ZvSlowQueriesTable;
  zv_sms_messages: ZvSmsMessagesTable;
  zv_sms_templates: ZvSmsTemplatesTable;
  zv_storage_quotas: ZvStorageQuotasTable;
  zv_sync_tombstones: ZvSyncTombstonesTable;
  zv_tenant_transfers: ZvTenantTransfersTable;
  zv_tenant_users: ZvTenantUsersTable;
  zv_tenants: ZvTenantsTable;
  zv_validation_rules: ZvValidationRulesTable;
  zvd_ai_embeddings: ZvdAiEmbeddingsTable;
  zvd_ai_search_config: ZvdAiSearchConfigTable;
  zvd_api_connections: ZvdApiConnectionsTable;
  zvd_api_endpoints: ZvdApiEndpointsTable;
  zvd_api_logs: ZvdApiLogsTable;
  zvd_api_oauth_tokens: ZvdApiOauthTokensTable;
  zvd_branch_review_requests: ZvdBranchReviewRequestsTable;
  zvd_byod_scan_history: ZvdByodScanHistoryTable;
  zvd_byod_scan_profiles: ZvdByodScanProfilesTable;
  zvd_collections: ZvdCollectionsTable;
  zvd_column_permissions: ZvdColumnPermissionsTable;
  zvd_dashboard_shares: ZvdDashboardSharesTable;
  zvd_dashboard_subscriptions: ZvdDashboardSubscriptionsTable;
  zvd_incoming_webhooks: ZvdIncomingWebhooksTable;
  zvd_insight_saved_queries: ZvdInsightSavedQueriesTable;
  zvd_ldap_config: ZvdLdapConfigTable;
  zvd_ldap_group_mappings: ZvdLdapGroupMappingsTable;
  zvd_ldap_ip_allowlist: ZvdLdapIpAllowlistTable;
  zvd_ldap_login_log: ZvdLdapLoginLogTable;
  zvd_mail_config: ZvdMailConfigTable;
  zvd_panel_cache: ZvdPanelCacheTable;
  zvd_permissions: ZvdPermissionsTable;
  zvd_permissions_pruned_012: ZvdPermissionsPruned012Table;
  zvd_permissions_pruned_033: ZvdPermissionsPruned033Table;
  zvd_permissions_pruned_034: ZvdPermissionsPruned034Table;
  zvd_push_tokens: ZvdPushTokensTable;
  zvd_push_tokens_superseded_013: ZvdPushTokensSuperseded013Table;
  zvd_relations: ZvdRelationsTable;
  zvd_rls_policies: ZvdRlsPoliciesTable;
  zvd_rpc_functions: ZvdRpcFunctionsTable;
  zvd_saml_attribute_mappings: ZvdSamlAttributeMappingsTable;
  zvd_saml_config: ZvdSamlConfigTable;
  zvd_saml_consumed_assertions: ZvdSamlConsumedAssertionsTable;
  zvd_saml_idp_metadata: ZvdSamlIdpMetadataTable;
  zvd_saml_login_log: ZvdSamlLoginLogTable;
  zvd_validation_import_log: ZvdValidationImportLogTable;
  zvd_validation_rule_groups: ZvdValidationRuleGroupsTable;
  zvd_validation_test_cases: ZvdValidationTestCasesTable;
  zvd_webhook_deliveries: ZvdWebhookDeliveriesTable;
  zvd_webhook_events: ZvdWebhookEventsTable;
  zvd_webhooks: ZvdWebhooksTable;
}
