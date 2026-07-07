/**
 * import-boundaries.ts — enforce the H-08 subsystem boundaries.
 *
 * Each subsystem directory under `packages/engine/src/lib/<name>/` that ships an
 * `index.ts` is a sealed unit: code OUTSIDE the subsystem must import it through
 * `lib/<name>` (the barrel), never a deep file `lib/<name>/<internal>.js`. This
 * keeps the public surface explicit and stops "extension code" from quietly
 * growing tendrils into "tenant code" again.
 *
 * Enforced subsystems are auto-detected (any lib/ subdir with an index.ts), so
 * new subsystems are covered without editing this script.
 *
 * Allowed:
 *   - imports from within the same subsystem (siblings, deep paths)
 *   - imports of the barrel itself (`lib/<name>` or `lib/<name>/index.js`)
 *   - test files (`*.test.ts`) — they may reach into internals on purpose
 *
 * No new dependency: walks `git ls-files`, resolves each import with node:path.
 *
 * Run: `bun run scripts/import-boundaries.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const ENGINE_LIB = resolve('packages/engine/src/lib').replace(/\\/g, '/');

function gitLsFiles(): string[] {
  const out = Bun.spawnSync(['git', 'ls-files', 'packages/engine/src']).stdout.toString();
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.ts'));
}

// Subsystems = lib/<name>/ that expose an index.ts.
function detectSubsystems(files: string[]): Set<string> {
  const subs = new Set<string>();
  for (const f of files) {
    const m = f.match(/packages\/engine\/src\/lib\/([^/]+)\/index\.ts$/);
    if (m) subs.add(m[1]);
  }
  return subs;
}

const IMPORT_RE = /(?:from|import\()\s*['"](\.\.?\/[^'"]+?)\.js['"]/g;

interface Violation {
  file: string;
  spec: string;
  subsystem: string;
}

function main(): void {
  const files = gitLsFiles();
  const subsystems = detectSubsystems(files);
  const violations: Violation[] = [];

  for (const file of files) {
    if (file.endsWith('.test.ts')) continue; // tests may deep-import internals
    const abs = resolve(file).replace(/\\/g, '/');
    const dir = dirname(abs);
    const content = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(content)) !== null) {
      const spec = m[1];
      const resolved = resolve(dir, spec).replace(/\\/g, '/');
      // Is the import target a deep file inside some subsystem?
      const rel = relative(ENGINE_LIB, resolved).replace(/\\/g, '/');
      const parts = rel.split('/');
      if (parts.length < 2 || parts[0] === '..') continue;
      const sub = parts[0];
      if (!subsystems.has(sub)) continue;
      const inner = parts.slice(1).join('/');
      if (inner === 'index') continue; // the barrel is fine
      // Is the importer itself inside this subsystem? Then deep import is fine.
      const importerInSub = abs.startsWith(`${ENGINE_LIB}/${sub}/`);
      if (importerInSub) continue;
      violations.push({ file, spec, subsystem: sub });
    }
  }

  if (violations.length === 0) {
    console.log(
      `✅ import-boundaries: no cross-subsystem deep imports (${subsystems.size} subsystems: ${[...subsystems].sort().join(', ')}).`,
    );
    return;
  }

  console.error('✗ import-boundaries: deep imports into a subsystem from outside it:');
  for (const v of violations) {
    console.error(`  - ${v.file}  →  ${v.spec}  (import from lib/${v.subsystem} barrel instead)`);
  }
  console.error(
    `\n${violations.length} violation(s). Route these through lib/<subsystem> (the index.ts).`,
  );
  process.exit(1);
}

main();
