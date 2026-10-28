#!/usr/bin/env bun
/**
 * Turn the kit into the package npm receives (ADR 0007: a published, versioned
 * surface). In the workspace `exports` point at `src/`, so the Console, the App
 * and extensions use the source with no build step. Published, they point at
 * `dist/`: `svelte-package` output, with a `.d.ts` beside every module.
 *
 * Rewrites `package.json` in place: run it only where the result is thrown
 * away (the publish job, the CI check). Fails if any export names a file the
 * build did not produce, so a new component left out of the build cannot ship
 * as a dangling path.
 */
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const build = Bun.spawnSync(['bun', 'x', 'svelte-package', '-i', 'src', '-o', 'dist'], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

type Target = Record<string, string>;
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
  exports: Record<string, Target>;
  files: string[];
};

// `./src/X.svelte` → `./dist/X.svelte` + `./dist/X.svelte.d.ts`;
// `./src/x.ts` (and `x.svelte.ts`) → `./dist/x.js` + `./dist/x.d.ts`.
for (const [key, target] of Object.entries(pkg.exports)) {
  const src = target.svelte ?? target.default;
  const out = src.replace('./src/', './dist/');
  pkg.exports[key] = src.endsWith('.svelte')
    ? { types: `${out}.d.ts`, svelte: out, default: out }
    : { types: out.replace(/\.ts$/, '.d.ts'), default: out.replace(/\.ts$/, '.js') };
}
pkg.files = ['dist', 'README.md'];

const missing = Object.values(pkg.exports)
  .flatMap((t) => Object.values(t))
  .filter((p) =>
    p.includes('*') ? globSync(p, { cwd: root }).length === 0 : !existsSync(join(root, p)),
  );
if (missing.length > 0) {
  console.error(`exports name files the build did not produce:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`✓ ${Object.keys(pkg.exports).length} exports point at dist/`);
