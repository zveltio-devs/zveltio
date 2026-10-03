/**
 * Generates src/db/migrations/embedded.ts from the sql/ directory.
 * Run via: bun scripts/gen-embedded-migrations.ts
 * Hooked into build so embedded.ts is never stale.
 *
 * `renderEmbedded()` is exported so the freshness gate can compare the
 * committed file against what this generator would emit, byte for byte,
 * without duplicating the template. Everything a reader of `embedded.ts`
 * needs to know has to be written HERE: the output is overwritten by every
 * build, so a note added to the generated file survives only until the next
 * one runs — silently, since nothing re-reads a comment.
 */

import { readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
export const SQL_DIR = join(__dir, '..', 'src', 'db', 'migrations', 'sql');
export const OUT_FILE = join(__dir, '..', 'src', 'db', 'migrations', 'embedded.ts');

/**
 * The migration files, refusing two that share a number.
 *
 * Applied migrations are tracked by number (`zv_schema_versions.version` is
 * UNIQUE). Two PRs that each pick the next free number merge without a
 * conflict — different filenames — and the second file then reads, on every
 * database, as "migration N was renumbered or squashed": boot refuses with
 * advice that does not fit. Refused here, the generator (run by every build)
 * and the embedded-migrations gate (run in CI) both name the clash.
 */
export function migrationFiles(sqlDir: string = SQL_DIR): string[] {
  const files = readdirSync(sqlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const byNumber = new Map<number, string[]>();
  for (const f of files) {
    const n = Number.parseInt(f, 10);
    byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
  }
  const clashes = [...byNumber.values()].filter((names) => names.length > 1);
  if (clashes.length > 0) {
    throw new Error(
      `Two migrations share a number: ${clashes.map((c) => c.join(' / ')).join('; ')}. ` +
        'Renumber the one that has not been released to the next free number.',
    );
  }
  return files;
}

export function renderEmbedded(files: string[]): string {
  const varName = (i: number) => `m${String(i).padStart(3, '0')}`;
  const imports = files
    .map((f, i) => `import ${varName(i)} from './sql/${f}' with { type: 'text' };`)
    .join('\n');
  const entries = files.map((f, i) => `  '${f}': ${varName(i)},`).join('\n');

  return `/**
 * Embedded SQL migrations — bundled at compile time by Bun.
 * When the engine runs as a standalone binary, \`import.meta.dir/sql\` does not
 * exist on the host filesystem. These imports are resolved at build time and
 * embedded verbatim into the binary via Bun's \`with { type: 'text' }\` syntax.
 *
 * The runner sorts by filename, so the leading number is what orders them; see
 * the BASELINE SQUASH note at the top of 001_initial.sql for why the chain
 * starts where it does. Adding a migration means dropping a .sql file into
 * sql/ and regenerating — there is no list to hand-edit.
 *
 * AUTO-GENERATED — do not edit by hand.
 * Regenerate with: bun scripts/gen-embedded-migrations.ts
 */

${imports}

/** Sorted map of filename → SQL content, embedded at compile time. */
export const EMBEDDED_MIGRATIONS: Record<string, string> = {
${entries}
};
`;
}

if (import.meta.main) {
  const files = migrationFiles();
  writeFileSync(OUT_FILE, renderEmbedded(files));
  console.log(`[gen-embedded-migrations] wrote ${files.length} migrations → embedded.ts`);
}
