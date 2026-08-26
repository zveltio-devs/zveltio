/**
 * Migrations embedded at compile time.
 *
 * The standalone Bun binary has no filesystem to read `sql/*.sql` from, so the
 * runner falls back to this map. Bun's `with { type: 'text' }` import inlines
 * each file's contents into the bundle.
 *
 * See the BASELINE SQUASH note at
 * the top of 001_initial.sql. Adding a migration means adding an import and an
 * entry here; the runner sorts by filename, so the number is what orders them.
 */

import m001 from './sql/001_initial.sql' with { type: 'text' };
import m002 from './sql/002_passkey.sql' with { type: 'text' };
import m003 from './sql/003_rls_parallel_safe.sql' with { type: 'text' };
import m004 from './sql/004_tenancy_hierarchy.sql' with { type: 'text' };

/** Sorted map of filename → SQL content, embedded at compile time. */
export const EMBEDDED_MIGRATIONS: Record<string, string> = {
  '001_initial.sql': m001,
  '002_passkey.sql': m002,
  '003_rls_parallel_safe.sql': m003,
  '004_tenancy_hierarchy.sql': m004,
};
