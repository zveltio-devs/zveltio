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

export interface ZvApprovalDecisionsTable {
  id: Generated<string>;
  request_id: string;
  step_id: string;
  decision: 'approved' | 'rejected' | 'skipped';
  decided_by: string | null;
  comment: string | null;
  decided_at: Generated<Date | null>;
  tenant_id: Generated<string | null>;
}

export interface ZvApprovalDelegatesTable {
  id: Generated<string>;
  delegator_id: string;
  delegate_id: string;
  workflow_id: string | null;
  valid_from: Generated<Date>;
  valid_until: Date | null;
  is_active: Generated<boolean>;
  reason: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvApprovalRequestsTable {
  id: Generated<string>;
  workflow_id: string;
  collection: string;
  record_id: string;
  current_step_id: string | null;
  status: Generated<'pending' | 'approved' | 'rejected' | 'cancelled'>;
  requested_by: string | null;
  requested_at: Generated<Date | null>;
  completed_at: Date | null;
  metadata: Generated<unknown | null>;
  priority: Generated<'low' | 'normal' | 'high' | 'urgent'>;
  sla_due_at: Date | null;
  sla_breached: Generated<boolean>;
  reminder_sent_at: Date | null;
  rejection_reason: string | null;
  tenant_id: Generated<string | null>;
}

export interface ZvApprovalSlaAlertsTable {
  id: Generated<string>;
  request_id: string;
  step_id: string | null;
  alert_type: Generated<'reminder' | 'overdue' | 'escalated'>;
  sent_to: string;
  sent_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvApprovalStepsTable {
  id: Generated<string>;
  workflow_id: string;
  step_order: Generated<number>;
  name: string;
  approver_role: string | null;
  approver_user_id: string | null;
  deadline_hours: number | null;
  is_required: Generated<boolean | null>;
  created_at: Generated<Date | null>;
  condition_field: string | null;
  condition_value: string | null;
  allow_parallel: Generated<boolean>;
  escalation_user_id: string | null;
  escalation_hours: number | null;
  tenant_id: Generated<string | null>;
}

export interface ZvApprovalTemplatesTable {
  id: Generated<string>;
  name: string;
  workflow_id: string;
  default_metadata: Generated<unknown>;
  description: string | null;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvApprovalWorkflowsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  collection: string;
  trigger_field: string | null;
  trigger_value: string | null;
  is_active: Generated<boolean | null>;
  created_by: string | null;
  created_at: Generated<Date | null>;
  updated_at: Generated<Date | null>;
  tenant_id: Generated<string | null>;
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

export interface ZvBillingPlansTable {
  id: Generated<string>;
  name: string;
  stripe_price_id: string | null;
  limits: Generated<unknown>;
  price_cents: Generated<number>;
  interval: Generated<string>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvBillingSubscriptionsTable {
  id: Generated<string>;
  tenant_id: Generated<string | null>;
  plan_id: string | null;
  stripe_subscription_id: string | null;
  status: Generated<string>;
  current_period_start: Date | null;
  current_period_end: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvBillingWebhookEventsTable {
  event_id: Generated<string>;
  received_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvChecklistItemsTable {
  id: Generated<string>;
  checklist_id: string;
  label: string;
  description: string | null;
  required: Generated<boolean>;
  order_idx: Generated<number>;
  checked: Generated<boolean>;
  checked_by: string | null;
  checked_at: Date | null;
  created_at: Generated<Date>;
  time_spent_minutes: number | null;
  due_at: Date | null;
  assignee_user_id: string | null;
  notes: string | null;
  tenant_id: Generated<string | null>;
  template_item_id: string | null;
}

export interface ZvChecklistRecurrenceTable {
  id: Generated<string>;
  template_id: string;
  collection: string;
  record_id: string;
  frequency: Generated<'daily' | 'weekly' | 'monthly' | 'quarterly'>;
  next_run_at: Date;
  last_run_at: Date | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvChecklistSchemeWeightsTable {
  id: Generated<string>;
  scheme_id: string;
  template_item_id: string;
  weight: Generated<number>;
  tenant_id: Generated<string>;
}

export interface ZvChecklistScoresTable {
  id: Generated<string>;
  checklist_id: string;
  scheme_id: string | null;
  scheme_name: string;
  method: string;
  score: number;
  passed: boolean | null;
  snapshot: Generated<unknown>;
  computed_at: Generated<Date>;
  tenant_id: Generated<string>;
}

export interface ZvChecklistScoringSchemesTable {
  id: Generated<string>;
  template_id: string;
  name: string;
  description: string | null;
  method: Generated<'weighted_completion'>;
  pass_threshold: number | null;
  is_active: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string>;
}

export interface ZvChecklistTemplateItemsTable {
  id: Generated<string>;
  template_id: string;
  label: string;
  description: string | null;
  required: Generated<boolean>;
  order_idx: Generated<number>;
  created_at: Generated<Date>;
  condition_item_label: string | null;
  condition_checked: boolean | null;
  time_estimate_minutes: number | null;
  assignee_role: string | null;
  tenant_id: Generated<string | null>;
}

export interface ZvChecklistTemplatesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  collection: string | null;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvChecklistsTable {
  id: Generated<string>;
  template_id: string | null;
  collection: string;
  record_id: string;
  name: string;
  created_by: string | null;
  completed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  time_to_complete_minutes: number | null;
  completed_by: string | null;
  tenant_id: Generated<string | null>;
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

export interface ZvCollectionPublishSettingsTable {
  id: Generated<string>;
  collection: string;
  require_review: Generated<boolean>;
  allow_self_publish: Generated<boolean>;
  notify_roles: Generated<string[]>;
  reviewer_roles: Generated<string[]>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvContentDraftsTable {
  id: Generated<string>;
  collection: string;
  record_id: string;
  draft_data: Generated<unknown>;
  base_version: Generated<number>;
  status: Generated<'draft' | 'review' | 'approved' | 'rejected' | 'published'>;
  notes: string | null;
  scheduled_at: Date | null;
  created_by: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  published_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  word_count: number | null;
  content_hash: string | null;
  reviewer_note: string | null;
  tenant_id: Generated<string | null>;
}

export interface ZvDashboardLayoutsTable {
  id: Generated<string>;
  scope: 'role' | 'user';
  owner: string;
  widgets: Generated<unknown>;
  updated_by: string | null;
  updated_at: Generated<Date>;
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

export interface ZvDocumentAccessLogTable {
  id: Generated<string>;
  document_id: string;
  user_id: string | null;
  ip: string | null;
  action: 'view' | 'download' | 'sign' | 'share';
  accessed_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvDocumentNumberSequencesTable {
  id: Generated<string>;
  template_id: string;
  prefix: Generated<string>;
  next_number: Generated<number>;
  year_reset: Generated<boolean>;
  reset_year: number | null;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvDocumentRenderJobsTable {
  id: Generated<string>;
  template_id: string;
  job_name: string;
  data_source: string;
  filter_config: Generated<unknown>;
  output_format: Generated<'pdf' | 'html' | 'zip'>;
  status: Generated<'pending' | 'running' | 'completed' | 'failed'>;
  total_records: number | null;
  processed_count: Generated<number>;
  failed_count: Generated<number>;
  output_zip_key: string | null;
  error: string | null;
  created_by: string;
  created_at: Generated<Date>;
  completed_at: Date | null;
  tenant_id: Generated<string | null>;
}

export interface ZvDocumentRendersTable {
  id: Generated<string>;
  template_id: string;
  variables: Generated<unknown>;
  output_format: Generated<'pdf' | 'html'>;
  file_key: string | null;
  file_size: number | null;
  rendered_by: string | null;
  rendered_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvDocumentSignRequestsTable {
  id: Generated<string>;
  document_id: string;
  signer_email: string;
  signer_name: string;
  sign_token: Generated<string>;
  signed_at: Date | null;
  ip_address: string | null;
  status: Generated<'pending' | 'signed' | 'declined' | 'expired'>;
  expires_at: Generated<Date>;
  message: string | null;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvDocumentTemplateAccessTable {
  id: Generated<string>;
  template_id: string;
  user_id: string | null;
  role_name: string | null;
  permission: Generated<'use' | 'edit' | 'admin'>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvDocumentTemplateVersionsTable {
  id: Generated<string>;
  template_id: string;
  version_number: number;
  html_body: string;
  css_styles: string | null;
  variables: Generated<unknown>;
  change_notes: string | null;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvDocumentTemplatesTable {
  id: Generated<string>;
  name: string;
  slug: string | null;
  description: string | null;
  category: string | null;
  html_body: Generated<string>;
  css_styles: string | null;
  variables: Generated<unknown>;
  pdf_options: Generated<unknown | null>;
  is_active: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  version_number: Generated<number>;
  tags: Generated<string[]>;
  usage_count: Generated<number>;
  last_used_at: Date | null;
  tenant_id: Generated<string | null>;
  template_type: Generated<string>;
  output_format: Generated<string>;
}

export interface ZvDraftPublishJobsTable {
  id: Generated<string>;
  draft_ids: string[];
  collection: string;
  status: Generated<'pending' | 'running' | 'completed' | 'failed'>;
  published_count: Generated<number>;
  failed_count: Generated<number>;
  errors: Generated<unknown>;
  created_by: string;
  created_at: Generated<Date>;
  completed_at: Date | null;
  tenant_id: Generated<string | null>;
}

export interface ZvDraftReviewCommentsTable {
  id: Generated<string>;
  draft_id: string;
  field_path: string | null;
  comment: string;
  type: Generated<'suggestion' | 'required' | 'info'>;
  resolved_at: Date | null;
  resolved_by: string | null;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvDraftSnapshotsTable {
  id: Generated<string>;
  draft_id: string;
  snapshot_data: Generated<unknown>;
  version: number;
  description: string | null;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvFormSubmissionsTable {
  id: Generated<string>;
  form_id: string | null;
  data: Generated<unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvFormsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  description: string | null;
  fields: Generated<unknown>;
  target_collection: string | null;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvGeneratedDocsTable {
  id: Generated<string>;
  template_id: string | null;
  template_name: string;
  source_collection: string | null;
  source_record_id: string | null;
  variables_used: Generated<unknown>;
  output_format: Generated<'pdf' | 'html'>;
  file_key: string | null;
  file_size: number | null;
  document_number: string | null;
  generated_by: string;
  generated_at: Generated<Date>;
  is_signed: Generated<boolean>;
  expires_at: Date | null;
  share_token: Generated<string | null>;
  status: Generated<'active' | 'expired' | 'revoked'>;
  tenant_id: Generated<string | null>;
}

export interface ZvGeoLocationHistoryTable {
  id: Generated<string>;
  entity_type: string;
  entity_id: string;
  location: unknown;
  accuracy_m: number | null;
  altitude_m: number | null;
  speed_kmh: number | null;
  heading_deg: number | null;
  source: Generated<string>;
  metadata: Generated<unknown>;
  recorded_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvGeoRoutesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  waypoints: Generated<unknown>;
  path: unknown | null;
  distance_m: number | null;
  metadata: Generated<unknown>;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvGeofenceEventsTable {
  id: Generated<string>;
  geofence_id: string;
  entity_type: string;
  entity_id: string;
  event_type: 'enter' | 'exit' | 'dwell';
  location: unknown | null;
  metadata: Generated<unknown>;
  occurred_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvGeofenceRulesTable {
  id: Generated<string>;
  geofence_id: string;
  name: string;
  trigger_on: 'enter' | 'exit' | 'both';
  entity_type: string | null;
  action_type: Generated<'webhook' | 'notification' | 'email'>;
  action_config: Generated<unknown>;
  is_active: Generated<boolean>;
  triggered_count: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvGeofencesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  zone: unknown;
  metadata: Generated<unknown>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvImportLogsTable {
  id: Generated<string>;
  collection: string;
  filename: string;
  file_format: Generated<'csv' | 'xlsx' | 'json' | 'ndjson'>;
  status: Generated<'pending' | 'running' | 'processing' | 'completed' | 'failed' | 'partial'>;
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
  profile_id: string | null;
  on_duplicate: Generated<string>;
  dry_run: Generated<boolean>;
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

export interface ZvMediaAiMetadataTable {
  id: Generated<string>;
  file_id: string;
  ai_labels: Generated<string[]>;
  ai_description: string | null;
  dominant_color: string | null;
  ocr_text: string | null;
  nsfw_score: number | null;
  is_nsfw: Generated<boolean>;
  analyzed_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMediaCdnInvalidationsTable {
  id: Generated<string>;
  file_ids: Generated<string[]>;
  paths: Generated<string[]>;
  status: Generated<'pending' | 'completed' | 'failed'>;
  provider: Generated<string>;
  invalidation_id: string | null;
  error: string | null;
  created_by: string;
  created_at: Generated<Date>;
  completed_at: Date | null;
  tenant_id: Generated<string | null>;
}

export interface ZvMediaCollectionFilesTable {
  collection_id: string;
  file_id: string;
  sort_order: Generated<number>;
  added_by: string;
  added_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvMediaCollectionsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  cover_file_id: string | null;
  is_public: Generated<boolean>;
  created_by: string;
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
  description: string | null;
  cover_image_id: string | null;
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

export interface ZvPageAbVariantsTable {
  id: Generated<string>;
  page_id: string;
  name: string;
  blocks: Generated<unknown>;
  traffic_pct: Generated<number>;
  is_active: Generated<boolean>;
  views: Generated<number>;
  conversions: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: string | null;
}

export interface ZvPageBlockTypesTable {
  id: Generated<string>;
  name: string;
  display_name: string;
  description: string | null;
  icon: string | null;
  schema: Generated<unknown>;
  default_props: Generated<unknown>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface ZvPageMenusTable {
  id: Generated<string>;
  menu_key: string;
  items: Generated<unknown>;
  updated_by: string | null;
  updated_at: Generated<Date>;
  tenant_id: string | null;
}

export interface ZvPageMetricsTable {
  page_id: string;
  date: Date;
  views: Generated<number>;
  unique_visitors: Generated<number>;
  avg_time_on_page_seconds: Generated<number>;
  bounce_rate: Generated<number>;
  tenant_id: string | null;
}

export interface ZvPageRedirectsTable {
  id: Generated<string>;
  from_path: string;
  to_path: string;
  redirect_type: Generated<number>;
  is_active: Generated<boolean>;
  hit_count: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: string | null;
}

export interface ZvPageRevisionsTable {
  id: Generated<string>;
  page_id: string;
  blocks: unknown;
  meta: Generated<unknown>;
  created_by: string | null;
  created_at: Generated<Date>;
  tenant_id: string | null;
}

export interface ZvPageSeoScoresTable {
  id: Generated<string>;
  page_id: string;
  overall_score: Generated<number>;
  title_score: Generated<number>;
  meta_description_score: Generated<number>;
  heading_score: Generated<number>;
  image_alt_score: Generated<number>;
  issues: Generated<unknown>;
  analyzed_at: Generated<Date>;
  tenant_id: string | null;
}

export interface ZvPageSitemapConfigTable {
  page_id: string;
  include_in_sitemap: Generated<boolean>;
  change_freq: Generated<'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'>;
  priority: Generated<number>;
  updated_at: Generated<Date>;
  tenant_id: string | null;
}

export interface ZvPageSitesTable {
  id: Generated<string>;
  tenant_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  is_active: Generated<boolean>;
  is_public: Generated<boolean>;
  access_roles: Generated<string[]>;
  public_collections: Generated<string[]>;
  base_path: string;
  site_name: string | null;
  site_logo_url: string | null;
  primary_color: Generated<string | null>;
  secondary_color: string | null;
  custom_css: string | null;
  nav_position: Generated<'sidebar' | 'topbar' | 'both' | null>;
  show_breadcrumbs: Generated<boolean>;
  legacy_zone_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvPageTemplatesTable {
  id: Generated<string>;
  tenant_id: Generated<string | null>;
  name: string;
  description: string | null;
  kind: Generated<'block' | 'page'>;
  blocks: Generated<unknown>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvPagesTable {
  id: Generated<string>;
  title: string;
  slug: string;
  description: string | null;
  status: Generated<string>;
  template: Generated<string>;
  blocks: Generated<unknown>;
  meta: Generated<unknown>;
  published_at: Date | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: string | null;
  locale: Generated<string>;
  og_image: string | null;
  meta_title: string | null;
  meta_description: string | null;
  is_noindex: Generated<boolean>;
  reading_time_minutes: number | null;
  canonical_page_id: string | null;
  site_id: string | null;
  parent_id: string | null;
  icon: string | null;
  is_active: Generated<boolean>;
  is_homepage: Generated<boolean>;
  auth_required: Generated<boolean>;
  allowed_roles: Generated<string[]>;
  sort_order: Generated<number>;
  legacy_zone_page_id: string | null;
  layout: Generated<string>;
  kind: Generated<'page' | 'popup'>;
  popup_config: Generated<unknown>;
  record_collection: string | null;
  record_field: string | null;
  record_filter: Generated<unknown>;
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

export interface ZvPublishScheduleTable {
  id: Generated<string>;
  draft_id: string;
  scheduled_at: Date;
  published_at: Date | null;
  status: Generated<'pending' | 'published' | 'failed' | 'cancelled'>;
  created_at: Generated<Date>;
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

export interface ZvQualityIssuesTable {
  id: Generated<string>;
  scan_id: string;
  collection: string;
  issue_type: string;
  severity: Generated<'info' | 'warning' | 'error'>;
  record_ids: Generated<string[]>;
  field_name: string | null;
  description: string;
  suggestion: string | null;
  auto_fixable: Generated<boolean>;
  dismissed: Generated<boolean>;
  created_at: Generated<Date>;
  record_id: string | null;
  value_sample: string | null;
  is_dismissed: Generated<boolean>;
  dismissed_by: string | null;
  dismissed_at: Date | null;
  tenant_id: Generated<string | null>;
}

export interface ZvQualityScansTable {
  id: Generated<string>;
  collection: string;
  scan_type: Generated<string>;
  status: Generated<'running' | 'completed' | 'failed'>;
  records_scanned: Generated<number>;
  issues_found: Generated<number>;
  triggered_by: string | null;
  started_at: Generated<Date>;
  completed_at: Date | null;
  total_records: Generated<number>;
  error: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvRoBudgetLinesTable {
  id: Generated<string>;
  code: string;
  name: string;
  year: number;
  allocated: Generated<number>;
  currency: Generated<string>;
  notes: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvRoContractsTable {
  id: Generated<string>;
  number: string;
  supplier_id: string | null;
  supplier_name: string;
  supplier_cui: string;
  title: string;
  type: Generated<'services' | 'goods' | 'works' | 'framework'>;
  value: number | null;
  currency: Generated<string>;
  start_date: Date | null;
  end_date: Date | null;
  auto_renew: Generated<boolean>;
  status: Generated<'draft' | 'active' | 'expired' | 'cancelled' | 'terminated'>;
  file_url: string | null;
  notes: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvRoDocNumberSequencesTable {
  type: Generated<string>;
  prefix: Generated<string>;
  year: Generated<number>;
  last_seq: Generated<number>;
  format: Generated<string>;
  updated_at: Generated<Date>;
  id: Generated<string>;
  tenant_id: Generated<string>;
}

export interface ZvRoDocumentSignatoriesTable {
  id: Generated<string>;
  document_id: string;
  name: string;
  role: Generated<string>;
  email: string | null;
  signed_at: Date | null;
  sign_order: Generated<number>;
  token: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvRoDocumentTemplatesTable {
  id: Generated<string>;
  name: string;
  type: string;
  description: string | null;
  template: string;
  variables: Generated<unknown>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvRoDocumentVersionsTable {
  id: Generated<string>;
  document_id: string;
  version: number;
  content: string | null;
  changed_by: string | null;
  change_note: string | null;
  created_at: Generated<Date>;
  metadata: Generated<unknown>;
  tenant_id: Generated<string | null>;
}

export interface ZvRoDocumentsTable {
  id: Generated<string>;
  type: string;
  number: string;
  date: Date;
  title: string;
  parties: Generated<unknown>;
  content: string | null;
  template_id: string | null;
  metadata: Generated<unknown>;
  status: Generated<string>;
  file_url: string | null;
  signed_at: Date | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  category: string | null;
  internal_notes: string | null;
  version_number: Generated<number>;
  archived_at: Date | null;
  tenant_id: Generated<string | null>;
}

export interface ZvRoPurchaseOrdersTable {
  id: Generated<string>;
  number: string;
  date: Date;
  supplier_id: string | null;
  supplier_name: string;
  supplier_cui: string;
  description: string;
  category: string | null;
  items: Generated<unknown>;
  subtotal: Generated<number>;
  vat_total: Generated<number>;
  total: Generated<number>;
  currency: Generated<string>;
  budget_line: string | null;
  status: Generated<string>;
  approved_by: string | null;
  approved_at: Date | null;
  received_at: Date | null;
  notes: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  contract_id: string | null;
  priority: Generated<'low' | 'normal' | 'high' | 'urgent'>;
  cancellation_reason: string | null;
  cancelled_at: Date | null;
  tenant_id: Generated<string | null>;
}

export interface ZvRoReceptionNotesTable {
  id: Generated<string>;
  number: string;
  order_id: string | null;
  supplier_id: string | null;
  supplier_name: string;
  date: Date;
  items: Generated<unknown>;
  total_value: Generated<number>;
  currency: Generated<string>;
  status: Generated<'draft' | 'confirmed' | 'disputed'>;
  discrepancies: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvRoSupplierEvaluationsTable {
  id: Generated<string>;
  supplier_id: string;
  period: string;
  quality_score: number;
  delivery_score: number;
  price_score: number;
  overall_score: number | null;
  notes: string | null;
  evaluated_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvRoSuppliersTable {
  id: Generated<string>;
  name: string;
  cui: string;
  reg_com: string | null;
  address: string | null;
  county: string | null;
  iban: string | null;
  bank: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  category: string | null;
  is_active: Generated<boolean>;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvRolesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  created_at: Generated<Date>;
}

export interface ZvSaftAccountsTable {
  id: Generated<string>;
  code: string;
  description: string;
  account_type: Generated<string>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvSaftExportsTable {
  id: Generated<string>;
  period_start: Date;
  period_end: Date;
  company_name: string;
  company_cui: string;
  company_address: string | null;
  status: Generated<string>;
  xml_content: string | null;
  anaf_response: unknown | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvSaftJournalEntriesTable {
  id: Generated<string>;
  account_code: string;
  entry_date: Date;
  description: string;
  debit: Generated<number>;
  credit: Generated<number>;
  document_number: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvUsageEventsTable {
  id: Generated<string>;
  tenant_id: Generated<string | null>;
  event_type: string;
  collection: string | null;
  quantity: Generated<number>;
  metadata: Generated<unknown | null>;
  created_at: Generated<Date>;
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

export interface ZvdApiAccessTokensTable {
  id: Generated<string>;
  name: string;
  token_hash: string;
  token_prefix: string;
  scopes: Generated<string[]>;
  expires_at: Date | null;
  last_used_at: Date | null;
  use_count: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  revoked_at: Date | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdApiChangelogsTable {
  id: Generated<string>;
  version: string;
  title: string;
  changes: string;
  breaking_changes: string | null;
  migration_guide: string | null;
  published_at: Date | null;
  is_published: Generated<boolean>;
  created_by: string;
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

export interface ZvdApiCustomDocsTable {
  id: Generated<string>;
  title: string;
  slug: string;
  body: string;
  sort_order: Generated<number>;
  is_published: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdApiDocsConfigTable {
  tenant_id: Generated<string>;
  is_public: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
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

export interface ZvdAssetDepreciationTable {
  id: Generated<string>;
  asset_id: string;
  period: string;
  amount: number;
  book_value_after: number;
  created_at: Generated<Date>;
  journal_entry_id: string | null;
  is_posted: Generated<boolean>;
  tenant_id: Generated<string | null>;
}

export interface ZvdAssetInsuranceTable {
  id: Generated<string>;
  asset_id: string;
  policy_number: string;
  insurer: string;
  type: Generated<string>;
  insured_value: number;
  premium: number | null;
  start_date: Date;
  end_date: Date;
  notes: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdAssetMaintenanceTable {
  id: Generated<string>;
  asset_id: string;
  type: Generated<'scheduled' | 'repair' | 'inspection'>;
  scheduled_date: Date;
  completed_date: Date | null;
  cost: number | null;
  description: string;
  performed_by: string | null;
  status: Generated<'scheduled' | 'completed' | 'overdue'>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdAssetRevaluationsTable {
  id: Generated<string>;
  asset_id: string;
  revaluation_date: Date;
  previous_value: number;
  new_value: number;
  method: Generated<'market' | 'cost' | 'expert_opinion'>;
  notes: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdAssetTransfersTable {
  id: Generated<string>;
  asset_id: string;
  from_location: string | null;
  to_location: string;
  transfer_date: Date;
  reason: string | null;
  transferred_by: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdAssetsTable {
  id: Generated<string>;
  code: string;
  name: string;
  description: string | null;
  category: Generated<
    'building' | 'equipment' | 'vehicle' | 'furniture' | 'software' | 'land' | 'other'
  >;
  status: Generated<'active' | 'disposed' | 'in_maintenance'>;
  purchase_date: Date;
  purchase_cost: number;
  residual_value: Generated<number>;
  useful_life_years: Generated<number>;
  depreciation_method: Generated<'straight_line' | 'declining_balance' | 'none'>;
  accumulated_depreciation: Generated<number>;
  current_value: Generated<number>;
  location: string | null;
  serial_number: string | null;
  supplier: string | null;
  warranty_expiry: Date | null;
  image_url: string | null;
  disposed_at: Date | null;
  disposal_value: number | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  depreciation_account_id: string | null;
  accumulated_dep_account_id: string | null;
  next_maintenance_date: Date | null;
  tenant_id: Generated<string | null>;
  disposal_reason: string | null;
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

export interface ZvdDunningAttemptsTable {
  id: Generated<string>;
  subscriber_id: string;
  invoice_id: string | null;
  attempt_number: Generated<number>;
  attempted_at: Generated<Date>;
  status: Generated<'pending' | 'success' | 'failed' | 'skipped'>;
  next_attempt_at: Date | null;
  notes: string | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcAbandonedCartsTable {
  id: Generated<string>;
  session_id: string;
  customer_email: string | null;
  customer_name: string | null;
  items: Generated<unknown>;
  subtotal: Generated<number>;
  recovery_token: Generated<string>;
  recovered_at: Date | null;
  reminder_sent_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcCategoriesTable {
  id: Generated<string>;
  name: string;
  slug: string;
  parent_id: string | null;
  description: string | null;
  image_url: string | null;
  sort_order: Generated<number>;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcCouponsTable {
  id: Generated<string>;
  code: string;
  type: Generated<'percent' | 'fixed'>;
  value: number;
  min_order_amount: number | null;
  max_uses: number | null;
  used_count: Generated<number>;
  valid_from: Generated<Date>;
  valid_until: Date | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcCustomersTable {
  id: Generated<string>;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  billing_address: Generated<unknown>;
  shipping_address: Generated<unknown>;
  notes: string | null;
  tags: Generated<string[] | null>;
  total_orders: Generated<number>;
  total_spent: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcOrderItemsTable {
  id: Generated<string>;
  order_id: string;
  product_id: string | null;
  product_name: string;
  sku: string | null;
  quantity: Generated<number>;
  unit_price: number;
  tax_rate: Generated<number>;
  discount: Generated<number>;
  total: number;
  variant_id: string | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcOrdersTable {
  id: Generated<string>;
  order_number: string;
  customer_id: string | null;
  customer_email: string;
  customer_name: string;
  status: Generated<'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded'>;
  payment_status: Generated<'unpaid' | 'paid' | 'refunded' | 'partial'>;
  payment_method: string | null;
  subtotal: Generated<number>;
  shipping_cost: Generated<number>;
  tax_amount: Generated<number>;
  discount: Generated<number>;
  total: Generated<number>;
  currency: Generated<string>;
  billing_address: Generated<unknown>;
  shipping_address: Generated<unknown>;
  shipping_tracking: string | null;
  notes: string | null;
  metadata: Generated<unknown>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  coupon_code: string | null;
  shipping_zone_id: string | null;
  tracking_number: string | null;
  canonical_contact_id: string | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcProductReviewsTable {
  id: Generated<string>;
  product_id: string;
  customer_id: string | null;
  customer_name: string;
  customer_email: string;
  order_id: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  status: Generated<'pending' | 'approved' | 'rejected'>;
  is_verified_purchase: Generated<boolean>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcProductVariantsTable {
  id: Generated<string>;
  product_id: string;
  sku: string;
  name: string;
  attributes: Generated<unknown>;
  price: number | null;
  compare_price: number | null;
  cost: number | null;
  stock_qty: Generated<number>;
  weight: number | null;
  image_url: string | null;
  is_active: Generated<boolean>;
  sort_order: Generated<number>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcProductsTable {
  id: Generated<string>;
  sku: string;
  name: string;
  slug: string;
  description: string | null;
  short_description: string | null;
  category_id: string | null;
  price: Generated<number>;
  compare_price: number | null;
  cost: number | null;
  currency: Generated<string>;
  tax_rate: Generated<number>;
  stock_qty: Generated<number>;
  track_stock: Generated<boolean>;
  allow_backorder: Generated<boolean>;
  weight: number | null;
  images: Generated<unknown>;
  attributes: Generated<unknown>;
  status: Generated<'draft' | 'active' | 'archived'>;
  is_featured: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  avg_rating: number | null;
  review_count: Generated<number>;
  tags: Generated<string[] | null>;
  digital_file_url: string | null;
  canonical_product_id: string | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcShippingRatesTable {
  id: Generated<string>;
  zone_id: string;
  name: string;
  type: Generated<'flat' | 'weight' | 'free_above'>;
  price: Generated<number>;
  min_weight: number | null;
  max_weight: number | null;
  free_above_amount: number | null;
  estimated_days_min: number | null;
  estimated_days_max: number | null;
  is_active: Generated<boolean>;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcShippingZonesTable {
  id: Generated<string>;
  name: string;
  countries: Generated<string[]>;
  regions: Generated<string[]>;
  is_active: Generated<boolean>;
  sort_order: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdEcTaxRulesTable {
  id: Generated<string>;
  name: string;
  country: Generated<string>;
  region: string | null;
  rate: Generated<number>;
  applies_to: Generated<'all' | 'physical' | 'digital'>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdExportAuditLogTable {
  id: Generated<string>;
  collection: string;
  format: string;
  record_count: Generated<number>;
  fields_exported: Generated<string[]>;
  filters_used: Generated<unknown>;
  exported_by: string;
  ip: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdExportJobsTable {
  id: Generated<string>;
  collection: string;
  format: Generated<'json' | 'csv' | 'ndjson' | 'xlsx' | 'parquet'>;
  filters: Generated<unknown>;
  fields: Generated<string[]>;
  status: Generated<'pending' | 'running' | 'completed' | 'failed'>;
  total_records: number | null;
  exported_records: Generated<number>;
  file_key: string | null;
  file_size_bytes: number | null;
  error: string | null;
  expires_at: Generated<Date>;
  created_by: string;
  created_at: Generated<Date>;
  completed_at: Date | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdExportTemplatesTable {
  id: Generated<string>;
  name: string;
  collection: string;
  format: Generated<string>;
  fields: Generated<string[]>;
  filters: Generated<unknown>;
  sort_field: string | null;
  sort_order: Generated<string>;
  description: string | null;
  is_public: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdGdprAccessRequestsTable {
  id: Generated<string>;
  requester_email: string;
  requester_name: string;
  request_type:
    | 'access'
    | 'erasure'
    | 'portability'
    | 'rectification'
    | 'restriction'
    | 'objection';
  description: string | null;
  status: Generated<'pending' | 'in_progress' | 'completed' | 'rejected' | 'withdrawn'>;
  due_date: Generated<Date>;
  assigned_to: string | null;
  resolution_notes: string | null;
  completed_at: Date | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdGdprBreachIncidentsTable {
  id: Generated<string>;
  title: string;
  description: string;
  discovered_at: Date;
  affected_records_estimate: number | null;
  data_categories: Generated<string[]>;
  severity: Generated<'low' | 'medium' | 'high' | 'critical'>;
  status: Generated<'open' | 'investigating' | 'contained' | 'reported' | 'closed'>;
  dpa_reported_at: Date | null;
  affected_users_notified_at: Date | null;
  root_cause: string | null;
  remediation_steps: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdGdprConsentsTable {
  id: Generated<string>;
  user_id: string | null;
  email: string | null;
  purpose: string;
  processing_record_id: string | null;
  granted: boolean;
  ip: string | null;
  user_agent: string | null;
  source: Generated<string>;
  withdrawn_at: Date | null;
  expires_at: Date | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdGdprProcessingRecordsTable {
  id: Generated<string>;
  name: string;
  purpose: string;
  legal_basis:
    | 'consent'
    | 'contract'
    | 'legal_obligation'
    | 'vital_interests'
    | 'public_task'
    | 'legitimate_interests';
  data_categories: Generated<string[]>;
  data_subjects: Generated<string[]>;
  retention_period_days: number | null;
  third_party_recipients: Generated<string[]>;
  technical_measures: string | null;
  organizational_measures: string | null;
  dpia_required: Generated<boolean>;
  dpia_completed_at: Date | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdGraphqlFieldPoliciesTable {
  id: Generated<string>;
  collection: string;
  field: string;
  allowed_roles: Generated<string[]>;
  deny_roles: Generated<string[]>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdGraphqlOperationLogsTable {
  id: Generated<string>;
  operation_name: string | null;
  operation_type: Generated<'query' | 'mutation' | 'subscription'>;
  query_hash: string;
  variables: unknown | null;
  duration_ms: number | null;
  result_size_bytes: number | null;
  error_count: Generated<number>;
  user_id: string | null;
  ip: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdGraphqlPersistedQueriesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  query: string;
  variables_schema: unknown | null;
  is_public: Generated<boolean>;
  allowed_roles: Generated<string[]>;
  use_count: Generated<number>;
  last_used_at: Date | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdImportMappingsTable {
  id: Generated<string>;
  name: string;
  collection: string;
  source_field: string;
  target_field: string;
  transform: string | null;
  default_value: string | null;
  is_required: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdImportProfilesTable {
  id: Generated<string>;
  name: string;
  collection: string;
  format: Generated<string>;
  delimiter: Generated<string>;
  has_header: Generated<boolean>;
  encoding: Generated<string>;
  on_duplicate: Generated<'skip' | 'update' | 'error'>;
  mappings: Generated<unknown>;
  description: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdImportRollbacksTable {
  id: Generated<string>;
  job_id: string;
  record_ids: Generated<string[]>;
  rolled_back_at: Date | null;
  rolled_back_by: string | null;
  status: Generated<'available' | 'rolled_back' | 'expired'>;
  expires_at: Generated<Date>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvdLocalesTable {
  code: Generated<string>;
  name: string;
  is_default: Generated<boolean>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  tenant_id: Generated<string>;
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

export interface ZvdPlanChangesTable {
  id: Generated<string>;
  subscriber_id: string;
  from_plan_id: string | null;
  to_plan_id: string;
  effective_date: Date;
  proration_amount: Generated<number | null>;
  reason: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdPosCashMovementsTable {
  id: Generated<string>;
  session_id: string;
  type: 'float_in' | 'float_out' | 'drop' | 'payout';
  amount: number;
  reason: string | null;
  cashier_id: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdPosCustomersTable {
  id: Generated<string>;
  name: string;
  email: string | null;
  phone: string | null;
  loyalty_points: Generated<number>;
  total_spent: Generated<number>;
  visit_count: Generated<number>;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  canonical_contact_id: string | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdPosHeldOrdersTable {
  id: Generated<string>;
  session_id: string;
  cashier_id: string;
  label: string | null;
  lines: Generated<unknown>;
  customer_id: string | null;
  notes: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdPosLoyaltyLogTable {
  id: Generated<string>;
  customer_id: string;
  order_id: string | null;
  delta: number;
  reason: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdPosOrderCountersTable {
  tenant_id: Generated<string>;
  next_number: Generated<number>;
  prefix: Generated<string>;
  padding: Generated<number>;
  updated_at: Generated<Date>;
}

export interface ZvdPosOrderLinesTable {
  id: Generated<string>;
  order_id: string;
  product_id: string | null;
  product_name: string;
  sku: string | null;
  quantity: Generated<number>;
  unit_price: number;
  tax_rate: Generated<number>;
  discount: Generated<number>;
  total: number;
  tenant_id: Generated<string | null>;
}

export interface ZvdPosOrdersTable {
  id: Generated<string>;
  session_id: string;
  order_number: string;
  payment_method: Generated<'cash' | 'card' | 'transfer' | 'voucher'>;
  subtotal: Generated<number>;
  tax_amount: Generated<number>;
  discount: Generated<number>;
  total: Generated<number>;
  status: Generated<'open' | 'paid' | 'voided' | 'refunded'>;
  created_at: Generated<Date>;
  created_by: string;
  customer_id: string | null;
  loyalty_points_earned: Generated<number>;
  loyalty_points_redeemed: Generated<number>;
  loyalty_discount: Generated<number>;
  canonical_contact_id: string | null;
  tenant_id: Generated<string | null>;
  customer_name: string | null;
  notes: string | null;
  updated_at: Generated<Date>;
}

export interface ZvdPosSessionsTable {
  id: Generated<string>;
  cashier_id: string;
  opened_at: Generated<Date>;
  closed_at: Date | null;
  opening_float: Generated<number>;
  closing_float: number | null;
  status: Generated<'open' | 'closed'>;
  notes: string | null;
  warehouse_id: string | null;
  tenant_id: Generated<string | null>;
  expected_float: number | null;
}

export interface ZvdPosZReportsTable {
  id: Generated<string>;
  session_id: string;
  total_sales: Generated<number>;
  total_refunds: Generated<number>;
  net_sales: Generated<number>;
  cash_sales: Generated<number>;
  card_sales: Generated<number>;
  order_count: Generated<number>;
  tax_amount: Generated<number>;
  generated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdProductBatchesTable {
  id: Generated<string>;
  product_id: string;
  warehouse_id: string;
  batch_number: string;
  lot_number: string | null;
  quantity: Generated<number>;
  expiry_date: Date | null;
  manufactured_date: Date | null;
  unit_cost: number | null;
  notes: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdProductVariantsTable {
  id: Generated<string>;
  product_id: string;
  sku: string | null;
  name: string;
  attributes: Generated<unknown>;
  unit_price: number | null;
  unit_cost: number | null;
  barcode: string | null;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdProductsTable {
  id: Generated<string>;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  category: string | null;
  unit: Generated<'piece' | 'kg' | 'liter' | 'box' | 'meter' | 'hour' | 'other'>;
  cost_price: Generated<number>;
  sale_price: Generated<number>;
  tax_rate: Generated<number>;
  reorder_point: Generated<number>;
  reorder_qty: Generated<number>;
  is_active: Generated<boolean>;
  image_url: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  avg_cost: Generated<number | null>;
  total_value: Generated<number | null>;
  tenant_id: Generated<string | null>;
  currency: Generated<string>;
}

export interface ZvdPurchaseOrderLinesTable {
  id: Generated<string>;
  po_id: string;
  product_id: string;
  quantity_ordered: number;
  quantity_received: Generated<number>;
  unit_cost: number;
  tax_rate: Generated<number>;
  total: number;
  sort_order: Generated<number>;
  tenant_id: Generated<string | null>;
}

export interface ZvdPurchaseOrdersTable {
  id: Generated<string>;
  number: string;
  supplier_id: string;
  warehouse_id: string | null;
  status: Generated<'draft' | 'sent' | 'partial' | 'received' | 'cancelled'>;
  expected_date: Date | null;
  received_date: Date | null;
  currency: Generated<string>;
  subtotal: Generated<number>;
  tax_amount: Generated<number>;
  total: Generated<number>;
  notes: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvdQualityRemediationsTable {
  id: Generated<string>;
  issue_id: string;
  action_type: 'set_default' | 'delete_record' | 'manual_review' | 'auto_fix';
  description: string;
  applied_at: Date | null;
  applied_by: string | null;
  result: string | null;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdQualityRulesTable {
  id: Generated<string>;
  name: string;
  collection: string;
  field_name: string | null;
  rule_type: 'not_null' | 'unique' | 'pattern' | 'range' | 'reference' | 'custom';
  rule_config: Generated<unknown>;
  severity: Generated<'info' | 'warning' | 'error' | 'critical'>;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdQualitySlaTargetsTable {
  id: Generated<string>;
  collection: string;
  max_critical_issues: Generated<number>;
  max_error_issues: Generated<number>;
  alert_email: string | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
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

export interface ZvdStockLevelsTable {
  id: Generated<string>;
  product_id: string;
  warehouse_id: string;
  quantity: Generated<number>;
  reserved_qty: Generated<number>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdStockMovementsTable {
  id: Generated<string>;
  product_id: string;
  warehouse_id: string;
  type: 'in' | 'out' | 'transfer' | 'adjustment';
  quantity: number;
  reference: string | null;
  note: string | null;
  created_by: string;
  created_at: Generated<Date>;
  avg_cost_after: number | null;
  batch_id: string | null;
  po_line_id: string | null;
  tenant_id: Generated<string | null>;
  unit_cost: number | null;
  destination_warehouse_id: string | null;
}

export interface ZvdSubscribersTable {
  id: Generated<string>;
  contact_id: string | null;
  organization_id: string | null;
  email: string;
  name: string;
  plan_id: string;
  status: Generated<
    'trialing' | 'active' | 'past_due' | 'paused' | 'cancel_scheduled' | 'cancelled' | 'expired'
  >;
  current_period_start: Generated<Date>;
  current_period_end: Date;
  trial_end: Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  cancel_at_period_end: Generated<boolean>;
  cancelled_at: Date | null;
  metadata: Generated<unknown>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  paused_at: Date | null;
  paused_until: Date | null;
  dunning_count: Generated<number>;
  payment_failure_at: Date | null;
  tenant_id: Generated<string | null>;
  cancellation_reason: string | null;
}

export interface ZvdSubscriptionInvoicesTable {
  id: Generated<string>;
  subscriber_id: string;
  plan_id: string;
  amount: number;
  currency: Generated<string>;
  status: Generated<'draft' | 'open' | 'paid' | 'void' | 'uncollectible'>;
  period_start: Date;
  period_end: Date;
  stripe_invoice_id: string | null;
  paid_at: Date | null;
  created_at: Generated<Date>;
  usage_amount: Generated<number>;
  total_amount: number | null;
  tenant_id: Generated<string | null>;
  updated_at: Generated<Date>;
  due_date: Date | null;
  created_by: string | null;
}

export interface ZvdSubscriptionPlansTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  price: Generated<number>;
  currency: Generated<string>;
  interval: Generated<'monthly' | 'quarterly' | 'yearly'>;
  trial_days: Generated<number>;
  features: Generated<unknown>;
  is_active: Generated<boolean>;
  stripe_price_id: string | null;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  usage_billing: Generated<boolean>;
  usage_metric: string | null;
  usage_unit_price: Generated<number | null>;
  max_usage: number | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdSubscriptionUsageTable {
  id: Generated<string>;
  subscriber_id: string;
  metric_name: string;
  quantity: number;
  unit_price: Generated<number>;
  recorded_at: Generated<Date>;
  billing_period_start: Date | null;
  billing_period_end: Date | null;
  is_billed: Generated<boolean>;
  tenant_id: Generated<string | null>;
}

export interface ZvdSuppliersTable {
  id: Generated<string>;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  tax_id: string | null;
  payment_terms: Generated<number | null>;
  currency: Generated<string | null>;
  notes: string | null;
  is_active: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdTranslationGlossaryTable {
  id: Generated<string>;
  term: string;
  locale: string;
  translation: string;
  definition: string | null;
  forbidden: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdTranslationImportJobsTable {
  id: Generated<string>;
  format: Generated<'json' | 'csv' | 'po' | 'xliff'>;
  locale: string;
  status: Generated<'pending' | 'processing' | 'completed' | 'failed'>;
  keys_total: Generated<number>;
  keys_imported: Generated<number>;
  keys_skipped: Generated<number>;
  error: string | null;
  created_by: string;
  created_at: Generated<Date>;
  completed_at: Date | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdTranslationKeysTable {
  id: Generated<string>;
  key: string;
  context: string | null;
  default_value: string | null;
  description: string | null;
  tags: Generated<string[]>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  max_length: number | null;
  is_pluralized: Generated<boolean>;
  screenshot_url: string | null;
  tenant_id: Generated<string | null>;
}

export interface ZvdTranslationMemoryTable {
  id: Generated<string>;
  source_text: string;
  target_text: string;
  locale: string;
  context: string | null;
  quality_score: Generated<number>;
  usage_count: Generated<number>;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
}

export interface ZvdTranslationsTable {
  id: Generated<string>;
  key_id: string;
  locale: string;
  value: string;
  is_machine_translated: Generated<boolean>;
  reviewed: Generated<boolean>;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  char_count: number | null;
  approved_by: string | null;
  approved_at: Date | null;
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
  expected_result: boolean;
  last_run_result: boolean | null;
  last_run_at: Date | null;
  created_by: string;
  created_at: Generated<Date>;
  tenant_id: Generated<string | null>;
  previous_value: string | null;
}

export interface ZvdWarehousesTable {
  id: Generated<string>;
  name: string;
  location: string | null;
  is_active: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  tenant_id: Generated<string | null>;
  notes: string | null;
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
  zv_approval_decisions: ZvApprovalDecisionsTable;
  zv_approval_delegates: ZvApprovalDelegatesTable;
  zv_approval_requests: ZvApprovalRequestsTable;
  zv_approval_sla_alerts: ZvApprovalSlaAlertsTable;
  zv_approval_steps: ZvApprovalStepsTable;
  zv_approval_templates: ZvApprovalTemplatesTable;
  zv_approval_workflows: ZvApprovalWorkflowsTable;
  zv_audit_log: ZvAuditLogTable;
  zv_backup_integrity_checks: ZvBackupIntegrityChecksTable;
  zv_backup_schedules: ZvBackupSchedulesTable;
  zv_backup_uploads: ZvBackupUploadsTable;
  zv_backups: ZvBackupsTable;
  zv_billing_plans: ZvBillingPlansTable;
  zv_billing_subscriptions: ZvBillingSubscriptionsTable;
  zv_billing_webhook_events: ZvBillingWebhookEventsTable;
  zv_checklist_items: ZvChecklistItemsTable;
  zv_checklist_recurrence: ZvChecklistRecurrenceTable;
  zv_checklist_scheme_weights: ZvChecklistSchemeWeightsTable;
  zv_checklist_scores: ZvChecklistScoresTable;
  zv_checklist_scoring_schemes: ZvChecklistScoringSchemesTable;
  zv_checklist_template_items: ZvChecklistTemplateItemsTable;
  zv_checklist_templates: ZvChecklistTemplatesTable;
  zv_checklists: ZvChecklistsTable;
  zv_cloud_access_logs: ZvCloudAccessLogsTable;
  zv_cloud_file_versions: ZvCloudFileVersionsTable;
  zv_cloud_retention_policies: ZvCloudRetentionPoliciesTable;
  zv_cloud_shares: ZvCloudSharesTable;
  zv_cloud_trash: ZvCloudTrashTable;
  zv_collection_publish_settings: ZvCollectionPublishSettingsTable;
  zv_content_drafts: ZvContentDraftsTable;
  zv_dashboard_layouts: ZvDashboardLayoutsTable;
  zv_dashboards: ZvDashboardsTable;
  zv_default_grant_revocations: ZvDefaultGrantRevocationsTable;
  zv_doc_templates: ZvDocTemplatesTable;
  zv_document_access_log: ZvDocumentAccessLogTable;
  zv_document_number_sequences: ZvDocumentNumberSequencesTable;
  zv_document_render_jobs: ZvDocumentRenderJobsTable;
  zv_document_renders: ZvDocumentRendersTable;
  zv_document_sign_requests: ZvDocumentSignRequestsTable;
  zv_document_template_access: ZvDocumentTemplateAccessTable;
  zv_document_template_versions: ZvDocumentTemplateVersionsTable;
  zv_document_templates: ZvDocumentTemplatesTable;
  zv_draft_publish_jobs: ZvDraftPublishJobsTable;
  zv_draft_review_comments: ZvDraftReviewCommentsTable;
  zv_draft_snapshots: ZvDraftSnapshotsTable;
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
  zv_form_submissions: ZvFormSubmissionsTable;
  zv_forms: ZvFormsTable;
  zv_generated_docs: ZvGeneratedDocsTable;
  zv_geo_location_history: ZvGeoLocationHistoryTable;
  zv_geo_routes: ZvGeoRoutesTable;
  zv_geofence_events: ZvGeofenceEventsTable;
  zv_geofence_rules: ZvGeofenceRulesTable;
  zv_geofences: ZvGeofencesTable;
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
  zv_media_ai_metadata: ZvMediaAiMetadataTable;
  zv_media_cdn_invalidations: ZvMediaCdnInvalidationsTable;
  zv_media_collection_files: ZvMediaCollectionFilesTable;
  zv_media_collections: ZvMediaCollectionsTable;
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
  zv_page_ab_variants: ZvPageAbVariantsTable;
  zv_page_block_types: ZvPageBlockTypesTable;
  zv_page_menus: ZvPageMenusTable;
  zv_page_metrics: ZvPageMetricsTable;
  zv_page_redirects: ZvPageRedirectsTable;
  zv_page_revisions: ZvPageRevisionsTable;
  zv_page_seo_scores: ZvPageSeoScoresTable;
  zv_page_sitemap_config: ZvPageSitemapConfigTable;
  zv_page_sites: ZvPageSitesTable;
  zv_page_templates: ZvPageTemplatesTable;
  zv_pages: ZvPagesTable;
  zv_panels: ZvPanelsTable;
  zv_pitr_config: ZvPitrConfigTable;
  zv_pitr_restore_points: ZvPitrRestorePointsTable;
  zv_prompt_templates: ZvPromptTemplatesTable;
  zv_publish_schedule: ZvPublishScheduleTable;
  zv_push_subscriptions: ZvPushSubscriptionsTable;
  zv_quality_issues: ZvQualityIssuesTable;
  zv_quality_scans: ZvQualityScansTable;
  zv_rag_documents: ZvRagDocumentsTable;
  zv_rate_limit_configs: ZvRateLimitConfigsTable;
  zv_record_comments: ZvRecordCommentsTable;
  zv_request_logs: ZvRequestLogsTable;
  zv_revisions: ZvRevisionsTable;
  zv_ro_budget_lines: ZvRoBudgetLinesTable;
  zv_ro_contracts: ZvRoContractsTable;
  zv_ro_doc_number_sequences: ZvRoDocNumberSequencesTable;
  zv_ro_document_signatories: ZvRoDocumentSignatoriesTable;
  zv_ro_document_templates: ZvRoDocumentTemplatesTable;
  zv_ro_document_versions: ZvRoDocumentVersionsTable;
  zv_ro_documents: ZvRoDocumentsTable;
  zv_ro_purchase_orders: ZvRoPurchaseOrdersTable;
  zv_ro_reception_notes: ZvRoReceptionNotesTable;
  zv_ro_supplier_evaluations: ZvRoSupplierEvaluationsTable;
  zv_ro_suppliers: ZvRoSuppliersTable;
  zv_roles: ZvRolesTable;
  zv_saft_accounts: ZvSaftAccountsTable;
  zv_saft_exports: ZvSaftExportsTable;
  zv_saft_journal_entries: ZvSaftJournalEntriesTable;
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
  zv_usage_events: ZvUsageEventsTable;
  zv_validation_rules: ZvValidationRulesTable;
  zvd_ai_embeddings: ZvdAiEmbeddingsTable;
  zvd_ai_search_config: ZvdAiSearchConfigTable;
  zvd_api_access_tokens: ZvdApiAccessTokensTable;
  zvd_api_changelogs: ZvdApiChangelogsTable;
  zvd_api_connections: ZvdApiConnectionsTable;
  zvd_api_custom_docs: ZvdApiCustomDocsTable;
  zvd_api_docs_config: ZvdApiDocsConfigTable;
  zvd_api_endpoints: ZvdApiEndpointsTable;
  zvd_api_logs: ZvdApiLogsTable;
  zvd_api_oauth_tokens: ZvdApiOauthTokensTable;
  zvd_asset_depreciation: ZvdAssetDepreciationTable;
  zvd_asset_insurance: ZvdAssetInsuranceTable;
  zvd_asset_maintenance: ZvdAssetMaintenanceTable;
  zvd_asset_revaluations: ZvdAssetRevaluationsTable;
  zvd_asset_transfers: ZvdAssetTransfersTable;
  zvd_assets: ZvdAssetsTable;
  zvd_branch_review_requests: ZvdBranchReviewRequestsTable;
  zvd_byod_scan_history: ZvdByodScanHistoryTable;
  zvd_byod_scan_profiles: ZvdByodScanProfilesTable;
  zvd_collections: ZvdCollectionsTable;
  zvd_column_permissions: ZvdColumnPermissionsTable;
  zvd_dashboard_shares: ZvdDashboardSharesTable;
  zvd_dashboard_subscriptions: ZvdDashboardSubscriptionsTable;
  zvd_dunning_attempts: ZvdDunningAttemptsTable;
  zvd_ec_abandoned_carts: ZvdEcAbandonedCartsTable;
  zvd_ec_categories: ZvdEcCategoriesTable;
  zvd_ec_coupons: ZvdEcCouponsTable;
  zvd_ec_customers: ZvdEcCustomersTable;
  zvd_ec_order_items: ZvdEcOrderItemsTable;
  zvd_ec_orders: ZvdEcOrdersTable;
  zvd_ec_product_reviews: ZvdEcProductReviewsTable;
  zvd_ec_product_variants: ZvdEcProductVariantsTable;
  zvd_ec_products: ZvdEcProductsTable;
  zvd_ec_shipping_rates: ZvdEcShippingRatesTable;
  zvd_ec_shipping_zones: ZvdEcShippingZonesTable;
  zvd_ec_tax_rules: ZvdEcTaxRulesTable;
  zvd_export_audit_log: ZvdExportAuditLogTable;
  zvd_export_jobs: ZvdExportJobsTable;
  zvd_export_templates: ZvdExportTemplatesTable;
  zvd_gdpr_access_requests: ZvdGdprAccessRequestsTable;
  zvd_gdpr_breach_incidents: ZvdGdprBreachIncidentsTable;
  zvd_gdpr_consents: ZvdGdprConsentsTable;
  zvd_gdpr_processing_records: ZvdGdprProcessingRecordsTable;
  zvd_graphql_field_policies: ZvdGraphqlFieldPoliciesTable;
  zvd_graphql_operation_logs: ZvdGraphqlOperationLogsTable;
  zvd_graphql_persisted_queries: ZvdGraphqlPersistedQueriesTable;
  zvd_import_mappings: ZvdImportMappingsTable;
  zvd_import_profiles: ZvdImportProfilesTable;
  zvd_import_rollbacks: ZvdImportRollbacksTable;
  zvd_incoming_webhooks: ZvdIncomingWebhooksTable;
  zvd_insight_saved_queries: ZvdInsightSavedQueriesTable;
  zvd_ldap_config: ZvdLdapConfigTable;
  zvd_ldap_group_mappings: ZvdLdapGroupMappingsTable;
  zvd_ldap_ip_allowlist: ZvdLdapIpAllowlistTable;
  zvd_ldap_login_log: ZvdLdapLoginLogTable;
  zvd_locales: ZvdLocalesTable;
  zvd_mail_config: ZvdMailConfigTable;
  zvd_panel_cache: ZvdPanelCacheTable;
  zvd_permissions: ZvdPermissionsTable;
  zvd_permissions_pruned_012: ZvdPermissionsPruned012Table;
  zvd_permissions_pruned_033: ZvdPermissionsPruned033Table;
  zvd_permissions_pruned_034: ZvdPermissionsPruned034Table;
  zvd_plan_changes: ZvdPlanChangesTable;
  zvd_pos_cash_movements: ZvdPosCashMovementsTable;
  zvd_pos_customers: ZvdPosCustomersTable;
  zvd_pos_held_orders: ZvdPosHeldOrdersTable;
  zvd_pos_loyalty_log: ZvdPosLoyaltyLogTable;
  zvd_pos_order_counters: ZvdPosOrderCountersTable;
  zvd_pos_order_lines: ZvdPosOrderLinesTable;
  zvd_pos_orders: ZvdPosOrdersTable;
  zvd_pos_sessions: ZvdPosSessionsTable;
  zvd_pos_z_reports: ZvdPosZReportsTable;
  zvd_product_batches: ZvdProductBatchesTable;
  zvd_product_variants: ZvdProductVariantsTable;
  zvd_products: ZvdProductsTable;
  zvd_purchase_order_lines: ZvdPurchaseOrderLinesTable;
  zvd_purchase_orders: ZvdPurchaseOrdersTable;
  zvd_push_tokens: ZvdPushTokensTable;
  zvd_push_tokens_superseded_013: ZvdPushTokensSuperseded013Table;
  zvd_quality_remediations: ZvdQualityRemediationsTable;
  zvd_quality_rules: ZvdQualityRulesTable;
  zvd_quality_sla_targets: ZvdQualitySlaTargetsTable;
  zvd_relations: ZvdRelationsTable;
  zvd_rls_policies: ZvdRlsPoliciesTable;
  zvd_rpc_functions: ZvdRpcFunctionsTable;
  zvd_saml_attribute_mappings: ZvdSamlAttributeMappingsTable;
  zvd_saml_config: ZvdSamlConfigTable;
  zvd_saml_consumed_assertions: ZvdSamlConsumedAssertionsTable;
  zvd_saml_idp_metadata: ZvdSamlIdpMetadataTable;
  zvd_saml_login_log: ZvdSamlLoginLogTable;
  zvd_stock_levels: ZvdStockLevelsTable;
  zvd_stock_movements: ZvdStockMovementsTable;
  zvd_subscribers: ZvdSubscribersTable;
  zvd_subscription_invoices: ZvdSubscriptionInvoicesTable;
  zvd_subscription_plans: ZvdSubscriptionPlansTable;
  zvd_subscription_usage: ZvdSubscriptionUsageTable;
  zvd_suppliers: ZvdSuppliersTable;
  zvd_translation_glossary: ZvdTranslationGlossaryTable;
  zvd_translation_import_jobs: ZvdTranslationImportJobsTable;
  zvd_translation_keys: ZvdTranslationKeysTable;
  zvd_translation_memory: ZvdTranslationMemoryTable;
  zvd_translations: ZvdTranslationsTable;
  zvd_validation_import_log: ZvdValidationImportLogTable;
  zvd_validation_rule_groups: ZvdValidationRuleGroupsTable;
  zvd_validation_test_cases: ZvdValidationTestCasesTable;
  zvd_warehouses: ZvdWarehousesTable;
  zvd_webhook_deliveries: ZvdWebhookDeliveriesTable;
  zvd_webhook_events: ZvdWebhookEventsTable;
  zvd_webhooks: ZvdWebhooksTable;
}
