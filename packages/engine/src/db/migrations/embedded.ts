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

/** Sorted map of filename → SQL content, embedded at compile time. */
export const EMBEDDED_MIGRATIONS: Record<string, string> = {
  '001_initial.sql': m000,
  '002_insights_panels_title.sql': m001,
  '003_translation_glossary.sql': m002,
  '004_invitations.sql': m003,
  '005_flow_dlq.sql': m004,
};
