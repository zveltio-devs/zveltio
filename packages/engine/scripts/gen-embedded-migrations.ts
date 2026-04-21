/**
 * Generates src/db/migrations/embedded.ts from the sql/ directory.
 * Run via: bun scripts/gen-embedded-migrations.ts
 * Hooked into build so embedded.ts is never stale.
 */

import { readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(__dir, '..', 'src', 'db', 'migrations', 'sql');
const outFile = join(__dir, '..', 'src', 'db', 'migrations', 'embedded.ts');

const files = readdirSync(sqlDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const imports = files
  .map((f, i) => {
    const varName = `m${String(i).padStart(3, '0')}`;
    return `import ${varName} from './sql/${f}' with { type: 'text' };`;
  })
  .join('\n');

const entries = files
  .map((f, i) => {
    const varName = `m${String(i).padStart(3, '0')}`;
    return `  '${f}': ${varName},`;
  })
  .join('\n');

const output = `/**
 * Embedded SQL migrations — bundled at compile time by Bun.
 * When the engine runs as a standalone binary, \`import.meta.dir/sql\` does not
 * exist on the host filesystem. These imports are resolved at build time and
 * embedded verbatim into the binary via Bun's \`with { type: 'text' }\` syntax.
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

writeFileSync(outFile, output);
console.log(`[gen-embedded-migrations] wrote ${files.length} migrations → embedded.ts`);
