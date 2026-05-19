/**
 * Embedded SQL migrations — bundled at compile time by Bun.
 * When the engine runs as a standalone binary, `import.meta.dir/sql` does not
 * exist on the host filesystem. These imports are resolved at build time and
 * embedded verbatim into the binary via Bun's `with { type: 'text' }` syntax.
 *
 * AUTO-GENERATED — do not edit by hand.
 * Regenerate with: bun scripts/gen-embedded-migrations.ts
 */

import m000 from './sql/000_schema_versions.sql' with { type: 'text' };
import m001 from './sql/001_auth.sql' with { type: 'text' };
import m002 from './sql/002_collections.sql' with { type: 'text' };
import m003 from './sql/003_settings.sql' with { type: 'text' };
import m004 from './sql/004_audit.sql' with { type: 'text' };
import m005 from './sql/005_storage.sql' with { type: 'text' };
import m006 from './sql/006_webhooks.sql' with { type: 'text' };
import m007 from './sql/007_notifications.sql' with { type: 'text' };
import m008 from './sql/008_api_keys.sql' with { type: 'text' };
import m009 from './sql/009_translations.sql' with { type: 'text' };
import m010 from './sql/010_import_logs.sql' with { type: 'text' };
import m011 from './sql/012_record_comments.sql' with { type: 'text' };
import m012 from './sql/013_extension_registry.sql' with { type: 'text' };
import m013 from './sql/014_ddl_retry.sql' with { type: 'text' };
import m014 from './sql/015_virtual_collections.sql' with { type: 'text' };
import m015 from './sql/016_multitenancy.sql' with { type: 'text' };
import m016 from './sql/017_flows.sql' with { type: 'text' };
import m017 from './sql/018_media.sql' with { type: 'text' };
import m018 from './sql/019_backups.sql' with { type: 'text' };
import m019 from './sql/020_pages.sql' with { type: 'text' };
import m020 from './sql/021_approvals.sql' with { type: 'text' };
import m021 from './sql/022_drafts.sql' with { type: 'text' };
import m022 from './sql/023_saved_queries.sql' with { type: 'text' };
import m023 from './sql/024_validation_rules.sql' with { type: 'text' };
import m024 from './sql/025_quality.sql' with { type: 'text' };
import m025 from './sql/026_insights.sql' with { type: 'text' };
import m026 from './sql/027_document_templates.sql' with { type: 'text' };
import m027 from './sql/028_documents.sql' with { type: 'text' };
import m028 from './sql/029_schema_branches.sql' with { type: 'text' };
import m029 from './sql/030_rls_tenant_guc.sql' with { type: 'text' };
import m030 from './sql/031_byod_is_managed.sql' with { type: 'text' };
import m031 from './sql/035_pitr.sql' with { type: 'text' };
import m032 from './sql/037_cloud_storage.sql' with { type: 'text' };
import m033 from './sql/038_protected_api.sql' with { type: 'text' };
import m034 from './sql/040_edge_functions.sql' with { type: 'text' };
import m035 from './sql/041_revisions_index.sql' with { type: 'text' };
import m036 from './sql/042_audit_log.sql' with { type: 'text' };
import m037 from './sql/044_user_auth_v15.sql' with { type: 'text' };
import m038 from './sql/046_slow_queries.sql' with { type: 'text' };
import m039 from './sql/047_encrypted_fields.sql' with { type: 'text' };
import m040 from './sql/048_roles.sql' with { type: 'text' };
import m041 from './sql/049_client_portal.sql' with { type: 'text' };
import m042 from './sql/050_zones_pages_views.sql' with { type: 'text' };
import m043 from './sql/051_fix_client_zone_base_path.sql' with { type: 'text' };
import m044 from './sql/052_role_cleanup.sql' with { type: 'text' };
import m045 from './sql/053_strip_data_prefix.sql' with { type: 'text' };
import m046 from './sql/054_rls_policies.sql' with { type: 'text' };
import m047 from './sql/055_rpc_whitelist.sql' with { type: 'text' };
import m048 from './sql/056_request_logs.sql' with { type: 'text' };
import m049 from './sql/057_rate_limit_configs.sql' with { type: 'text' };
import m050 from './sql/058_performance_indexes.sql' with { type: 'text' };
import m051 from './sql/059_pg_trgm.sql' with { type: 'text' };
import m052 from './sql/060_column_permissions.sql' with { type: 'text' };
import m053 from './sql/061_push_tokens.sql' with { type: 'text' };
import m054 from './sql/062_backup_schedules.sql' with { type: 'text' };
import m055 from './sql/063_schema_branches_reviews.sql' with { type: 'text' };
import m056 from './sql/064_schema_branches_preview_envs.sql' with { type: 'text' };
import m057 from './sql/065_schema_branches_preview_token_expiry.sql' with { type: 'text' };
import m058 from './sql/066_schema_branches_approval_gates.sql' with { type: 'text' };
import m059 from './sql/067_insights.sql' with { type: 'text' };
import m060 from './sql/068_insights_enterprise.sql' with { type: 'text' };
import m061 from './sql/069_insights_reconcile.sql' with { type: 'text' };
import m062 from './sql/070_extension_registry_tenant.sql' with { type: 'text' };
import m063 from './sql/071_zv_migrations_down_sql.sql' with { type: 'text' };
import m064 from './sql/072_extension_schedule_runs.sql' with { type: 'text' };
import m065 from './sql/073_license_audit.sql' with { type: 'text' };
import m066 from './sql/074_drop_legacy_ddl_jobs.sql' with { type: 'text' };
import m067 from './sql/075_electric_replication.sql' with { type: 'text' };
import m068 from './sql/076_erd_layout.sql' with { type: 'text' };

/** Sorted map of filename → SQL content, embedded at compile time. */
export const EMBEDDED_MIGRATIONS: Record<string, string> = {
  '000_schema_versions.sql': m000,
  '001_auth.sql': m001,
  '002_collections.sql': m002,
  '003_settings.sql': m003,
  '004_audit.sql': m004,
  '005_storage.sql': m005,
  '006_webhooks.sql': m006,
  '007_notifications.sql': m007,
  '008_api_keys.sql': m008,
  '009_translations.sql': m009,
  '010_import_logs.sql': m010,
  '012_record_comments.sql': m011,
  '013_extension_registry.sql': m012,
  '014_ddl_retry.sql': m013,
  '015_virtual_collections.sql': m014,
  '016_multitenancy.sql': m015,
  '017_flows.sql': m016,
  '018_media.sql': m017,
  '019_backups.sql': m018,
  '020_pages.sql': m019,
  '021_approvals.sql': m020,
  '022_drafts.sql': m021,
  '023_saved_queries.sql': m022,
  '024_validation_rules.sql': m023,
  '025_quality.sql': m024,
  '026_insights.sql': m025,
  '027_document_templates.sql': m026,
  '028_documents.sql': m027,
  '029_schema_branches.sql': m028,
  '030_rls_tenant_guc.sql': m029,
  '031_byod_is_managed.sql': m030,
  '035_pitr.sql': m031,
  '037_cloud_storage.sql': m032,
  '038_protected_api.sql': m033,
  '040_edge_functions.sql': m034,
  '041_revisions_index.sql': m035,
  '042_audit_log.sql': m036,
  '044_user_auth_v15.sql': m037,
  '046_slow_queries.sql': m038,
  '047_encrypted_fields.sql': m039,
  '048_roles.sql': m040,
  '049_client_portal.sql': m041,
  '050_zones_pages_views.sql': m042,
  '051_fix_client_zone_base_path.sql': m043,
  '052_role_cleanup.sql': m044,
  '053_strip_data_prefix.sql': m045,
  '054_rls_policies.sql': m046,
  '055_rpc_whitelist.sql': m047,
  '056_request_logs.sql': m048,
  '057_rate_limit_configs.sql': m049,
  '058_performance_indexes.sql': m050,
  '059_pg_trgm.sql': m051,
  '060_column_permissions.sql': m052,
  '061_push_tokens.sql': m053,
  '062_backup_schedules.sql': m054,
  '063_schema_branches_reviews.sql': m055,
  '064_schema_branches_preview_envs.sql': m056,
  '065_schema_branches_preview_token_expiry.sql': m057,
  '066_schema_branches_approval_gates.sql': m058,
  '067_insights.sql': m059,
  '068_insights_enterprise.sql': m060,
  '069_insights_reconcile.sql': m061,
  '070_extension_registry_tenant.sql': m062,
  '071_zv_migrations_down_sql.sql': m063,
  '072_extension_schedule_runs.sql': m064,
  '073_license_audit.sql': m065,
  '074_drop_legacy_ddl_jobs.sql': m066,
  '075_electric_replication.sql': m067,
  '076_erd_layout.sql': m068,
};
