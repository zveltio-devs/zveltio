/**
 * @zveltio/sdk/build
 *
 * Public API for authors who want to compile their extension bundle
 * from a custom build script (not via `zveltio extension pack`).
 *
 * The canonical pipeline is still `zveltio extension pack` — it
 * understands the manifest, computes the hash, and patches the
 * integrity block. This module exposes the underlying `Bun.build`
 * plugin so authors with non-standard build flows (monorepo
 * orchestration, custom entrypoints, IDE integration) can produce
 * the SAME artifact bytes.
 *
 * Usage:
 *
 * ```ts
 * import { createExtensionBuildConfig } from '@zveltio/sdk/build';
 *
 * const result = await Bun.build({
 *   ...createExtensionBuildConfig({
 *     entry: './engine/index.ts',
 *     outdir: './engine',
 *     resolveDir: process.cwd(),
 *   }),
 * });
 * ```
 *
 * After build, compute SHA-256 of `engine/index.js` and write it to
 * `manifest.integrity.engineSha256` — the engine refuses to load any
 * bundled extension whose on-disk bytes don't match the declared hash.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';

const require = createRequire(import.meta.url);

/**
 * Packages that the engine ships in its compiled binary AND that
 * Bun's bundler resolves to `.d.ts` (not `.js`) due to an exports-
 * condition quirk. The plugin below forces them to resolve to their
 * ESM JavaScript entrypoints so the bundle actually runs.
 */
export const EXTENSION_BUNDLE_CORE_DEPS = [
  'hono',
  'zod',
  'kysely',
  '@hono/zod-validator',
] as const;

const BUNDLE_CONDITIONS = ['import', 'bun', 'node', 'default'] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickExportTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object') {
    const o = target as Record<string, unknown>;
    if (typeof o.import === 'string') return o.import;
    if (typeof o.default === 'string') return o.default;
    if (o.import) return pickExportTarget(o.import);
  }
  return undefined;
}

function resolveSearchPaths(resolveFromDir: string): string[] {
  const paths = [resolveFromDir];
  let cur = resolveFromDir;
  for (let i = 0; i < 6; i++) {
    cur = dirname(cur);
    paths.push(cur);
    if (existsSync(join(cur, 'node_modules'))) break;
  }
  return [...new Set(paths)];
}

function resolvePackageRoot(pkg: string, searchPaths: string[]): string {
  let candidate: string;
  try {
    candidate = dirname(require.resolve(pkg, { paths: searchPaths }));
  } catch {
    throw new Error(
      `Cannot find package "${pkg}" from ${searchPaths[0]}. ` +
        `Run \`bun install\` in the extension directory or monorepo root.`,
    );
  }
  for (;;) {
    const pkgJsonPath = join(candidate, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
      if (manifest.name === pkg) return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`Cannot find package root for "${pkg}"`);
}

function resolvePackageEsmEntry(pkg: string, resolveFromDir: string): string {
  const searchPaths = resolveSearchPaths(resolveFromDir);
  const root = resolvePackageRoot(pkg, searchPaths);
  const pkgJsonPath = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    exports?: Record<string, unknown>;
    module?: string;
    main?: string;
  };
  const dot = manifest.exports?.['.'];
  let rel = pickExportTarget(dot);
  rel ??= manifest.module ?? manifest.main;
  if (!rel || typeof rel !== 'string') {
    throw new Error(`Cannot determine ESM entry for package "${pkg}"`);
  }
  const abs = join(root, rel.replace(/^\.\//, ''));
  if (!existsSync(abs)) {
    throw new Error(`ESM entry missing for "${pkg}": ${abs}`);
  }
  if (abs.endsWith('.d.ts')) {
    throw new Error(
      `Package "${pkg}" resolved to a declaration file (${abs}). ` +
        `Expected exports.import or module field to point at JavaScript.`,
    );
  }
  return abs;
}

/**
 * Bun plugin that forces the core extension deps (hono / zod / kysely
 * / @hono/zod-validator) to resolve to their ESM `.js` entrypoints
 * during build. Works around Bun's exports-condition matching picking
 * `.d.ts` for hono-style packages.
 */
export function createExtensionBundleResolvePlugin(resolveFromDir: string): BunPlugin {
  return {
    name: 'zveltio-extension-bundle-resolve',
    setup(build) {
      for (const pkg of EXTENSION_BUNDLE_CORE_DEPS) {
        const filter = new RegExp(`^${escapeRegExp(pkg)}$`);
        build.onResolve({ filter }, () => ({
          path: resolvePackageEsmEntry(pkg, resolveFromDir),
        }));
      }
    },
  };
}

export interface ExtensionBuildConfigOptions {
  /** Absolute path to the extension's `engine/index.ts`. */
  entry: string;
  /** Directory the build output lands in (typically `<ext>/engine`). */
  outdir: string;
  /** Extension root — used to walk node_modules for peer-dep resolution. */
  resolveDir: string;
  /** External packages to leave as bare imports. Use sparingly — Bun's
   *  compiled binary cannot resolve bare specifiers from dynamically-
   *  imported disk files. Default: []. */
  external?: string[];
  /** Emit a `.map` next to the bundle. Default: false. */
  sourcemap?: boolean;
}

/**
 * Build a `Bun.build` config object the SAME way `zveltio extension
 * pack` does. Returns the full options object including the resolve
 * plugin and bundle conditions — spread it into your own `Bun.build`
 * call.
 */
export function createExtensionBuildConfig(opts: ExtensionBuildConfigOptions) {
  return {
    entrypoints: [opts.entry],
    outdir: opts.outdir,
    target: 'bun' as const,
    format: 'esm' as const,
    sourcemap: (opts.sourcemap ? 'linked' : 'none') as 'linked' | 'none',
    external: opts.external ?? [],
    conditions: [...BUNDLE_CONDITIONS],
    plugins: [createExtensionBundleResolvePlugin(opts.resolveDir)],
  };
}
