/**
 * Shared file-set enumerator for the `noExplicitAny` codemod + ratchet.
 *
 * The codemod (`suppress-existing-any.ts`) and the ratchet (`any-ratchet.ts`)
 * MUST agree on which files are in scope, otherwise the ratchet would guard a
 * different set than the one it suppressed. Both import this module so there is
 * exactly one definition of "a file where `noExplicitAny` is enforced".
 *
 * Scope = every TypeScript/Svelte source file that Biome lints at `error`
 * severity for `suspicious/noExplicitAny`. That means: all `.ts`/`.tsx`/
 * `.svelte` under version control, MINUS
 *   - the paths excluded in `biome.json`'s `files.includes` (dist, build,
 *     node_modules, studio-dist, generated worker source, embedded/SQL
 *     migrations, …), and
 *   - test files, which `biome.json`'s `overrides` block sets back to `off`
 *     (tests are allowed `any` on purpose).
 *
 * Kept in sync with `biome.json` by hand — if you change the exclusions there,
 * mirror them here. `any-ratchet.ts --verify` guards the other direction: that
 * nobody flips the rule back to `off` and neuters the gate.
 */

import { execFileSync } from 'node:child_process';

/** Repo-relative POSIX paths (git ls-files output form). */
export type RepoPath = string;

/**
 * Path prefixes/patterns excluded from `noExplicitAny` enforcement.
 * The first group mirrors `biome.json` `files.includes` negations; the second
 * mirrors the tests `overrides` block (rule → off for tests).
 */
const EXCLUDE: RegExp[] = [
  // --- biome.json files.includes negations ---
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.svelte-kit\//,
  /(^|\/)\.zveltio\//,
  /(^|\/)coverage\//,
  /\.min\.js$/,
  /^packages\/engine\/src\/studio-dist\//,
  /^packages\/engine\/src\/db\/migrations\/embedded\.ts$/,
  /^packages\/engine\/src\/db\/migrations\/sql\//,
  /^packages\/engine\/src\/lib\/worker-extension-runtime-source\.generated\.ts$/,
  // --- tests overrides (noExplicitAny → off) ---
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /(^|\/)tests\//,
  /(^|\/)__tests__\//,
];

/** Only these extensions carry TS `any`; `.js`/`.jsx` cannot use the annotation. */
const INCLUDE_EXT = /\.(ts|tsx|svelte)$/;

/**
 * Returns the sorted list of in-scope repo-relative paths, straight from git so
 * untracked scratch files never leak into the baseline.
 */
export function enumerateTargets(cwd: string = process.cwd()): RepoPath[] {
  const out = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.svelte'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && INCLUDE_EXT.test(l) && !EXCLUDE.some((re) => re.test(l)))
    .sort();
}

/**
 * Maps a repo path to its ratchet bucket: the workspace package name for files
 * under `packages/<pkg>/`, `scripts` for build tooling, else `other`. Buckets
 * are what the baseline tracks so a regression is attributed to a package.
 */
export function bucketOf(path: RepoPath): string {
  const pkg = path.match(/^packages\/([^/]+)\//);
  if (pkg) return pkg[1];
  if (path.startsWith('scripts/')) return 'scripts';
  return 'other';
}

/** The excluded-prefix list, exported for the biome.json cross-check. */
export const EXCLUDE_SOURCE = EXCLUDE.map((re) => re.source);
