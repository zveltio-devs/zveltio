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
};
