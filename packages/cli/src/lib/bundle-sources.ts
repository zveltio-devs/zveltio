/**
 * The source files an extension's engine bundle is built from, and their hash
 * (`integrity.sourceSha256`).
 *
 * `integrity.engineSha256` says the committed bundle matches what the manifest
 * declares. It cannot say the bundle matches the SOURCE, and those are
 * different claims: on 2026-08-02 three security fixes were written into
 * `content/drafts/engine/routes.ts`, committed, reviewed and merged — and never
 * ran anywhere, because nobody repacked. The bundle and the manifest agreed
 * with each other perfectly. They were simply both older than the code.
 *
 * Repacking in CI to compare bytes would be the obvious check and the wrong
 * one: bundler output is not stable across Bun versions, so it would fail for
 * reasons that have nothing to do with the author. Hashing the INPUT is
 * deterministic, needs no bundler, and answers the question actually being
 * asked — has the source moved since this artifact was built?
 *
 * Pack, `extension validate`, `extension dev` and the extensions repository's
 * gate (`scripts/check-bundle-sources.ts`, run there against its checkout) all
 * read this one module, so the rule cannot drift between them.
 *
 * No dependency beyond node built-ins and Bun: the gate imports it from a bare
 * sibling clone.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** The bundle entries `extension pack` builds. */
const ENTRIES = ['index.ts', 'jobs.ts'];

const loaderFor = (file: string): 'ts' | 'tsx' | 'js' | 'jsx' | null => {
  const ext = file.slice(file.lastIndexOf('.') + 1);
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'ts';
  if (ext === 'tsx') return 'tsx';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'js';
  if (ext === 'jsx') return 'jsx';
  return null;
};

/**
 * Every source file under `engine/` (not tests, not `migrations/` — SQL the
 * engine applies, not compiled in — and not the bundle itself), plus every
 * file the bundle entries reach through relative imports, wherever it lives.
 * `content/pages/engine/index.ts` imports `../client/icons.js`: it is in the
 * bundle, so an edit to it makes the bundle stale. Bare specifiers
 * (`@zveltio/sdk`, `node_modules`) are dependencies, which
 * `check-embedded-deps-fresh` follows by version.
 *
 * The `engine/` walk is kept even for files no entry imports, so a manifest
 * packed before imports were followed keeps its hash unless an import leaves
 * `engine/`.
 */
export function bundleSourceFiles(dir: string): string[] {
  const engineDir = join(dir, 'engine');
  const files = new Set<string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'migrations' || entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs|json)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.[a-z]+$/.test(entry.name)) continue;
      if (entry.name === 'index.js') continue; // the artifact itself
      files.add(full);
    }
  };
  if (existsSync(engineDir)) walk(engineDir);

  const seen = new Set<string>();
  const queue = ENTRIES.map((e) => join(engineDir, e)).filter((f) => existsSync(f));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.add(file);
    const loader = loaderFor(file);
    if (!loader) continue; // JSON, text: imported, hashed, imports nothing
    // Type-only imports are dropped here as the bundler drops them.
    const imports = new Bun.Transpiler({ loader }).scanImports(readFileSync(file, 'utf8'));
    for (const { path: spec } of imports) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      let target: string;
      try {
        target = Bun.resolveSync(spec, dirname(file));
      } catch {
        continue; // unresolvable: the bundle cannot be built from it either
      }
      if (target.split(sep).includes('node_modules')) continue;
      // `./index.js` resolves to the bundle once it exists; the bundle is not its own source.
      if (target === join(engineDir, 'index.js')) continue;
      queue.push(target);
    }
  }
  return [...files];
}

/**
 * sha256 over `bundleSourceFiles(dir)`, each as its path relative to `engine/`
 * (`/routes.ts`, `/../client/icons.ts`) and its bytes, sorted by that path so
 * the digest depends on neither directory order nor where the checkout lives.
 * The path is hashed with the bytes, so a rename counts as a change.
 */
export function hashEngineSources(dir: string): string {
  const engineDir = join(dir, 'engine');
  const keyed = bundleSourceFiles(dir)
    .map((f) => [`/${relative(engineDir, f).split(sep).join('/')}`, f] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256');
  for (const [key, f] of keyed) {
    h.update(key);
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}
