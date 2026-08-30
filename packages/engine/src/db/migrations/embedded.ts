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

/** Sorted map of filename → SQL content, embedded at compile time. */
export const EMBEDDED_MIGRATIONS: Record<string, string> = {
  '001_initial.sql': m000,
  '002_passkey.sql': m001,
  '003_rls_parallel_safe.sql': m002,
  '004_tenancy_hierarchy.sql': m003,
  '005_rls_initplan_predicate.sql': m004,
  '006_better_auth_account_issuer.sql': m005,
  '007_ext_registry_tenant_unique.sql': m006,
};
