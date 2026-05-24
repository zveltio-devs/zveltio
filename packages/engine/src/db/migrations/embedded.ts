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

/** Sorted map of filename → SQL content, embedded at compile time. */
export const EMBEDDED_MIGRATIONS: Record<string, string> = {
  '001_initial.sql': m000,
};
