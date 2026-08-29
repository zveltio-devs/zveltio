/**
 * Every `bun <file>` in a package.json script must point at a file that exists.
 *
 * `db:init` read `bun scripts/init-db.ts` for long enough that the script it
 * named had been deleted; running it produced `Module not found` and nothing
 * else noticed, because no gate ever asked whether a script's target was real.
 * The entries are cheap to check and the failure is otherwise invisible until
 * somebody types the command.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');

/** Package roots: the repo itself plus every workspace member. */
function packageRoots(): string[] {
  const roots = [REPO];
  const pkgDir = join(REPO, 'packages');
  if (existsSync(pkgDir)) {
    for (const entry of readdirSync(pkgDir)) {
      if (existsSync(join(pkgDir, entry, 'package.json'))) roots.push(join(pkgDir, entry));
    }
  }
  return roots;
}

/**
 * File paths a script hands to `bun`, with the base directory it resolves
 * against. A leading `cd <dir> &&` moves that base, which several scripts use.
 */
function referencedFiles(script: string, base: string): { file: string; base: string }[] {
  let dir = base;
  const cd = /^cd\s+([^\s&]+)\s*&&\s*/.exec(script);
  const rest = cd ? script.slice(cd[0].length) : script;
  if (cd) dir = join(base, cd[1]!);

  const out: { file: string; base: string }[] = [];
  // `bun x`, `bunx` and `bun run <name>` take a package or a script name, not a
  // path — only a bare token ending in .ts/.js is a file on disk.
  for (const m of rest.matchAll(/(?:^|\s)((?:\.{0,2}\/)?[\w.@/-]+\.(?:ts|js|mjs))(?=\s|$)/g)) {
    const candidate = m[1]!;
    if (candidate.startsWith('-')) continue;
    // `dist/` is what the build writes; it is legitimately absent before one.
    if (candidate.startsWith('dist/') || candidate.includes('/dist/')) continue;
    out.push({ file: candidate, base: dir });
  }
  return out;
}

describe('package.json scripts point at files that exist', () => {
  const roots = packageRoots();

  it('finds the workspace packages to check', () => {
    expect(roots.length).toBeGreaterThan(1);
  });

  it('studio typecheck generates its own tsconfig before running', () => {
    // `tsc --noEmit` alone fails on a fresh checkout: the studio tsconfig extends
    // `.svelte-kit/tsconfig.json`, which `svelte-kit sync` writes and which is
    // .gitignored. Without it TypeScript falls back to defaults and emits dozens
    // of errors that look like real ones and are not.
    const pkg = JSON.parse(
      readFileSync(join(REPO, 'packages', 'studio', 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.typecheck).toContain('svelte-kit sync');
  });

  for (const root of roots) {
    const rel = root === REPO ? '<repo>' : `packages/${root.split('/').pop()}`;
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};

    it(`${rel} — every referenced file is on disk`, () => {
      const missing: string[] = [];
      for (const [name, script] of Object.entries(scripts)) {
        for (const { file, base } of referencedFiles(script, root)) {
          if (!existsSync(join(base, file))) missing.push(`${rel} → ${name}: ${file}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
