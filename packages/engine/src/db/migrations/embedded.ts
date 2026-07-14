/**
 * Embedded SQL migrations — bundled at compile time by Bun.
 * When the engine runs as a standalone binary, `import.meta.dir/sql` does not
 * exist on the host filesystem. These imports are resolved at build time and
 * embedded verbatim into the binary via Bun's `with { type: 'text' }` syntax.
 *
 * AUTO-GENERATED — do not edit by hand.
 * Regenerate with: bun scripts/gen-embedded-migrations.ts
 */

import m000 from './sql/001_initial.sql' with { type: 'text' };
import m001 from './sql/002_insights_panels_title.sql' with { type: 'text' };
import m002 from './sql/003_translation_glossary.sql' with { type: 'text' };
import m003 from './sql/004_invitations.sql' with { type: 'text' };
import m004 from './sql/005_flow_dlq.sql' with { type: 'text' };
import m005 from './sql/006_extension_load_errors.sql' with { type: 'text' };
import m006 from './sql/007_default_tenant.sql' with { type: 'text' };
import m007 from './sql/008_casbin_domains.sql' with { type: 'text' };
import m008 from './sql/009_tenant_role_policies.sql' with { type: 'text' };
import m009 from './sql/010_media_tenant_isolation.sql' with { type: 'text' };
import m010 from './sql/011_approvals_tenant_isolation.sql' with { type: 'text' };
import m011 from './sql/012_media_tags_tenant_isolation.sql' with { type: 'text' };
import m012 from './sql/013_dashboards_tenant_isolation.sql' with { type: 'text' };
import m013 from './sql/014_flows_tenant_isolation.sql' with { type: 'text' };
import m014 from './sql/015_edge_functions_tenant_isolation.sql' with { type: 'text' };

/** Sorted map of filename → SQL content, embedded at compile time. */
export const EMBEDDED_MIGRATIONS: Record<string, string> = {
  '001_initial.sql': m000,
  '002_insights_panels_title.sql': m001,
  '003_translation_glossary.sql': m002,
  '004_invitations.sql': m003,
  '005_flow_dlq.sql': m004,
  '006_extension_load_errors.sql': m005,
  '007_default_tenant.sql': m006,
  '008_casbin_domains.sql': m007,
  '009_tenant_role_policies.sql': m008,
  '010_media_tenant_isolation.sql': m009,
  '011_approvals_tenant_isolation.sql': m010,
  '012_media_tags_tenant_isolation.sql': m011,
  '013_dashboards_tenant_isolation.sql': m012,
  '014_flows_tenant_isolation.sql': m013,
  '015_edge_functions_tenant_isolation.sql': m014,
};
