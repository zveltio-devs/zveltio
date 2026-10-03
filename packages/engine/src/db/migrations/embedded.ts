/**
 * Embedded SQL migrations — bundled at compile time by Bun.
 * When the engine runs as a standalone binary, `import.meta.dir/sql` does not
 * exist on the host filesystem. These imports are resolved at build time and
 * embedded verbatim into the binary via Bun's `with { type: 'text' }` syntax.
 *
 * The runner sorts by filename, so the leading number is what orders them; see
 * the BASELINE SQUASH note at the top of 001_initial.sql for why the chain
 * starts where it does. Adding a migration means dropping a .sql file into
 * sql/ and regenerating — there is no list to hand-edit.
 *
 * AUTO-GENERATED — do not edit by hand.
 * Regenerate with: bun scripts/gen-embedded-migrations.ts
 */

import m000 from './sql/001_initial.sql' with { type: 'text' };
import m001 from './sql/002_passkey.sql' with { type: 'text' };
import m002 from './sql/003_rls_parallel_safe.sql' with { type: 'text' };
import m003 from './sql/004_tenancy_hierarchy.sql' with { type: 'text' };
import m004 from './sql/005_rls_initplan_predicate.sql' with { type: 'text' };
import m005 from './sql/006_better_auth_account_issuer.sql' with { type: 'text' };
import m006 from './sql/007_ext_registry_tenant_unique.sql' with { type: 'text' };
import m007 from './sql/008_single_god.sql' with { type: 'text' };
import m008 from './sql/009_revisions_unwrap_double_encoded.sql' with { type: 'text' };
import m009 from './sql/010_unwrap_double_encoded_jsonb.sql' with { type: 'text' };
import m010 from './sql/011_unwrap_collections_fields_jsonb.sql' with { type: 'text' };
import m011 from './sql/012_prune_resurrected_role_grants.sql' with { type: 'text' };
import m012 from './sql/013_push_token_single_owner.sql' with { type: 'text' };
import m013 from './sql/014_push_token_unique_index.sql' with { type: 'text' };
import m014 from './sql/015_permission_view_means_read.sql' with { type: 'text' };
import m015 from './sql/016_default_tenant_unlimited.sql' with { type: 'text' };
import m016 from './sql/017_prune_deleted_user_grants.sql' with { type: 'text' };
import m017 from './sql/018_drop_tenant_plans_and_quota.sql' with { type: 'text' };
import m018 from './sql/019_seed_untuned_rate_limit_tiers.sql' with { type: 'text' };
import m019 from './sql/020_user_sign_in_block.sql' with { type: 'text' };
import m020 from './sql/021_media_files_api_key_owner.sql' with { type: 'text' };
import m021 from './sql/022_media_files_api_key_owner_index.sql' with { type: 'text' };
import m022 from './sql/023_media_tables_rls.sql' with { type: 'text' };
import m023 from './sql/024_revisions_import_logs_rls.sql' with { type: 'text' };
import m024 from './sql/025_revoke_orphaned_api_keys.sql' with { type: 'text' };
import m025 from './sql/026_dashboards_rls.sql' with { type: 'text' };
import m026 from './sql/027_flows_rls.sql' with { type: 'text' };
import m027 from './sql/028_webhooks_rls.sql' with { type: 'text' };
import m028 from './sql/029_environments_rls.sql' with { type: 'text' };
import m029 from './sql/030_policed_tables_tenant_created_index.sql' with { type: 'text' };
import m030 from './sql/031_media_shares_tenant_backfill.sql' with { type: 'text' };
import m031 from './sql/032_sync_tombstones.sql' with { type: 'text' };
import m032 from './sql/033_drop_column_role_mirror.sql' with { type: 'text' };
import m033 from './sql/034_drop_removed_member_tenant_grants.sql' with { type: 'text' };
import m034 from './sql/035_user_ban_source.sql' with { type: 'text' };
import m035 from './sql/036_record_comments_parent_index.sql' with { type: 'text' };
import m036 from './sql/037_backup_schedule_id.sql' with { type: 'text' };
import m037 from './sql/038_hash_invitation_tokens.sql' with { type: 'text' };
import m038 from './sql/039_unwrap_jsonb_string_scalars.sql' with { type: 'text' };
import m039 from './sql/040_audit_log_tenant.sql' with { type: 'text' };
import m040 from './sql/041_audit_log_tenant_index.sql' with { type: 'text' };
import m041 from './sql/042_junction_tenant_rls.sql' with { type: 'text' };

/** Sorted map of filename → SQL content, embedded at compile time. */
export const EMBEDDED_MIGRATIONS: Record<string, string> = {
  '001_initial.sql': m000,
  '002_passkey.sql': m001,
  '003_rls_parallel_safe.sql': m002,
  '004_tenancy_hierarchy.sql': m003,
  '005_rls_initplan_predicate.sql': m004,
  '006_better_auth_account_issuer.sql': m005,
  '007_ext_registry_tenant_unique.sql': m006,
  '008_single_god.sql': m007,
  '009_revisions_unwrap_double_encoded.sql': m008,
  '010_unwrap_double_encoded_jsonb.sql': m009,
  '011_unwrap_collections_fields_jsonb.sql': m010,
  '012_prune_resurrected_role_grants.sql': m011,
  '013_push_token_single_owner.sql': m012,
  '014_push_token_unique_index.sql': m013,
  '015_permission_view_means_read.sql': m014,
  '016_default_tenant_unlimited.sql': m015,
  '017_prune_deleted_user_grants.sql': m016,
  '018_drop_tenant_plans_and_quota.sql': m017,
  '019_seed_untuned_rate_limit_tiers.sql': m018,
  '020_user_sign_in_block.sql': m019,
  '021_media_files_api_key_owner.sql': m020,
  '022_media_files_api_key_owner_index.sql': m021,
  '023_media_tables_rls.sql': m022,
  '024_revisions_import_logs_rls.sql': m023,
  '025_revoke_orphaned_api_keys.sql': m024,
  '026_dashboards_rls.sql': m025,
  '027_flows_rls.sql': m026,
  '028_webhooks_rls.sql': m027,
  '029_environments_rls.sql': m028,
  '030_policed_tables_tenant_created_index.sql': m029,
  '031_media_shares_tenant_backfill.sql': m030,
  '032_sync_tombstones.sql': m031,
  '033_drop_column_role_mirror.sql': m032,
  '034_drop_removed_member_tenant_grants.sql': m033,
  '035_user_ban_source.sql': m034,
  '036_record_comments_parent_index.sql': m035,
  '037_backup_schedule_id.sql': m036,
  '038_hash_invitation_tokens.sql': m037,
  '039_unwrap_jsonb_string_scalars.sql': m038,
  '040_audit_log_tenant.sql': m039,
  '041_audit_log_tenant_index.sql': m040,
  '042_junction_tenant_rls.sql': m041,
};
