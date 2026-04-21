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
import m011 from './sql/011_ai.sql' with { type: 'text' };
import m012 from './sql/012_record_comments.sql' with { type: 'text' };
import m013 from './sql/013_extension_registry.sql' with { type: 'text' };
import m014 from './sql/014_ddl_retry.sql' with { type: 'text' };
import m015 from './sql/015_virtual_collections.sql' with { type: 'text' };
import m016 from './sql/016_multitenancy.sql' with { type: 'text' };
import m017 from './sql/017_flows.sql' with { type: 'text' };
import m018 from './sql/018_media.sql' with { type: 'text' };
import m019 from './sql/019_backups.sql' with { type: 'text' };
import m020 from './sql/020_pages.sql' with { type: 'text' };
import m021 from './sql/021_approvals.sql' with { type: 'text' };
import m022 from './sql/022_drafts.sql' with { type: 'text' };
import m023 from './sql/023_saved_queries.sql' with { type: 'text' };
import m024 from './sql/024_validation_rules.sql' with { type: 'text' };
import m025 from './sql/025_quality.sql' with { type: 'text' };
import m026 from './sql/026_insights.sql' with { type: 'text' };
import m027 from './sql/027_document_templates.sql' with { type: 'text' };
import m028 from './sql/028_documents.sql' with { type: 'text' };
import m029 from './sql/029_schema_branches.sql' with { type: 'text' };
import m030 from './sql/030_rls_tenant_guc.sql' with { type: 'text' };
import m031 from './sql/031_byod_is_managed.sql' with { type: 'text' };
import m032 from './sql/032_ai_embeddings.sql' with { type: 'text' };
import m033 from './sql/033_ai_search_config.sql' with { type: 'text' };
import m034 from './sql/034_ai_decision_step.sql' with { type: 'text' };
import m035 from './sql/035_pitr.sql' with { type: 'text' };
import m036 from './sql/036_ai_task_trigger.sql' with { type: 'text' };
import m037 from './sql/037_cloud_storage.sql' with { type: 'text' };
import m038 from './sql/038_protected_api.sql' with { type: 'text' };
import m039 from './sql/039_ai_query.sql' with { type: 'text' };
import m040 from './sql/040_edge_functions.sql' with { type: 'text' };
import m041 from './sql/041_revisions_index.sql' with { type: 'text' };
import m042 from './sql/042_audit_log.sql' with { type: 'text' };
import m043 from './sql/043_ai_embed_excluded_fields.sql' with { type: 'text' };
import m044 from './sql/044_user_auth_v15.sql' with { type: 'text' };
import m045 from './sql/045_ai_memory.sql' with { type: 'text' };
import m046 from './sql/046_slow_queries.sql' with { type: 'text' };
import m047 from './sql/047_encrypted_fields.sql' with { type: 'text' };
import m048 from './sql/048_roles.sql' with { type: 'text' };
import m049 from './sql/049_client_portal.sql' with { type: 'text' };
import m050 from './sql/050_zones_pages_views.sql' with { type: 'text' };
import m051 from './sql/051_fix_client_zone_base_path.sql' with { type: 'text' };
import m052 from './sql/052_role_cleanup.sql' with { type: 'text' };
import m053 from './sql/053_strip_data_prefix.sql' with { type: 'text' };

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
  '011_ai.sql': m011,
  '012_record_comments.sql': m012,
  '013_extension_registry.sql': m013,
  '014_ddl_retry.sql': m014,
  '015_virtual_collections.sql': m015,
  '016_multitenancy.sql': m016,
  '017_flows.sql': m017,
  '018_media.sql': m018,
  '019_backups.sql': m019,
  '020_pages.sql': m020,
  '021_approvals.sql': m021,
  '022_drafts.sql': m022,
  '023_saved_queries.sql': m023,
  '024_validation_rules.sql': m024,
  '025_quality.sql': m025,
  '026_insights.sql': m026,
  '027_document_templates.sql': m027,
  '028_documents.sql': m028,
  '029_schema_branches.sql': m029,
  '030_rls_tenant_guc.sql': m030,
  '031_byod_is_managed.sql': m031,
  '032_ai_embeddings.sql': m032,
  '033_ai_search_config.sql': m033,
  '034_ai_decision_step.sql': m034,
  '035_pitr.sql': m035,
  '036_ai_task_trigger.sql': m036,
  '037_cloud_storage.sql': m037,
  '038_protected_api.sql': m038,
  '039_ai_query.sql': m039,
  '040_edge_functions.sql': m040,
  '041_revisions_index.sql': m041,
  '042_audit_log.sql': m042,
  '043_ai_embed_excluded_fields.sql': m043,
  '044_user_auth_v15.sql': m044,
  '045_ai_memory.sql': m045,
  '046_slow_queries.sql': m046,
  '047_encrypted_fields.sql': m047,
  '048_roles.sql': m048,
  '049_client_portal.sql': m049,
  '050_zones_pages_views.sql': m050,
  '051_fix_client_zone_base_path.sql': m051,
  '052_role_cleanup.sql': m052,
  '053_strip_data_prefix.sql': m053,
};
