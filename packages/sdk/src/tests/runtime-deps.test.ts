/**
 * Every package the published SDK imports at run time must be a dependency.
 *
 * `kysely` (`toJsonb`) and `hono` (`/testing`) were devDependencies: inside the
 * monorepo they resolved from the workspace, and an extension scaffolded
 * outside it failed at `import '@zveltio/sdk/extension'` with
 * `Could not resolve: "kysely"` (DR-28). Type-only imports and dynamic
 * `import()` (optional peers such as testcontainers) are not checked.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'tests' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('SDK runtime dependencies', () => {
  it('declares every bare package imported at run time', () => {
    const missing: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(
        /^(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^'.][^']*)'/gm,
      )) {
        const spec = m[1]!;
        if (spec.startsWith('node:') || spec.startsWith('bun:')) continue;
        const name = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0]!;
        if (!pkg.dependencies?.[name]) missing.push(`${file.slice(SRC.length + 1)}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
