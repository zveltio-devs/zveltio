#!/usr/bin/env bun
/**
 * Gate: every migration on disk is embedded in the compiled binary.
 *
 * `getMaxSchemaVersion()` globs `db/migrations/sql/` when that directory
 * exists and falls back to `EMBEDDED_MIGRATIONS` when it does not. In dev the
 * glob wins, so a migration added without regenerating `embedded.ts` is
 * invisible: every suite reads the same number the database has and passes.
 * The compiled binary has no sql/ directory, reads the stale embedded map, and
 * refuses to start — "Database schema is newer than this engine version" —
 * while a fresh install never creates the missing objects at all.
 *
 * Nothing on master exercises that path. `release.yml` runs on tag, so the
 * first execution of the binary is the release itself. beta.44 shipped broken
 * this way; migrations 029-033 reached master the same way and were caught
 * only by compiling by hand before the tag. A gate is cheaper than remembering.
 *
 * Compares the SET OF VERSION NUMBERS, not file contents. Contents are already
 * covered — `embedded.ts` imports each .sql with `type: 'text'`, so a changed
 * file is embedded verbatim at build time and cannot drift. What drifts is
 * membership: a file nobody added an import line for.
 *
 * Usage: bun scripts/check-embedded-migrations-fresh.ts
 */

import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SQL_DIR = join(ROOT, 'packages/engine/src/db/migrations/sql');
const EMBEDDED = join(ROOT, 'packages/engine/src/db/migrations/embedded.ts');

const REGEN = 'bun packages/engine/scripts/gen-embedded-migrations.ts';

function versionsFrom(names: Iterable<string>): Set<number> {
  const out = new Set<number>();
  for (const n of names) {
    const m = n.match(/(\d+)_/);
    if (m) out.add(Number.parseInt(m[1], 10));
  }
  return out;
}

const onDisk = versionsFrom(new Bun.Glob('*.sql').scanSync({ cwd: SQL_DIR, onlyFiles: true }));

// Read the generated file as text rather than importing it: the import
// evaluates `with { type: 'text' }` attributes, which is slower and drags the
// whole migration corpus into memory for a set comparison.
const embeddedText = await Bun.file(EMBEDDED).text();
const embedded = versionsFrom(embeddedText.match(/['"]\.\/sql\/(\d+_[^'"]+)['"]/g) ?? []);

const missing = [...onDisk].filter((v) => !embedded.has(v)).sort((a, b) => a - b);
const extra = [...embedded].filter((v) => !onDisk.has(v)).sort((a, b) => a - b);

if (missing.length > 0) {
  const pad = (v: number) => String(v).padStart(3, '0');
  console.error(
    `❌ embedded-migrations-fresh: ${missing.length} migration(s) on disk are NOT in the compiled binary.\n\n` +
      `   Missing: ${missing.map(pad).join(', ')}\n\n` +
      '   Tests pass anyway — dev reads the sql/ directory directly. The binary\n' +
      '   cannot, so it would refuse to start against a database carrying these.\n\n' +
      `   Regenerate:  ${REGEN}\n`,
  );
  process.exit(1);
}

if (extra.length > 0) {
  const pad = (v: number) => String(v).padStart(3, '0');
  console.error(
    `❌ embedded-migrations-fresh: ${extra.length} embedded migration(s) no longer exist on disk.\n\n` +
      `   Stale: ${extra.map(pad).join(', ')}\n\n` +
      `   Regenerate:  ${REGEN}\n`,
  );
  process.exit(1);
}

console.log(
  `✅ embedded-migrations-fresh: all ${onDisk.size} migrations are embedded (max ${Math.max(...onDisk)}).`,
);
