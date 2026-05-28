/**
 * Bundle extension engine sources with Bun.build + a small resolve plugin.
 *
 * `bun build` on the CLI resolves some packages (notably `hono`) to their
 * `exports.types` (.d.ts) entry instead of `exports.import` (.js). This plugin
 * forces core runtime deps to their ESM JavaScript entrypoints before Bun's
 * bundler parses them.
 *
 * See: https://github.com/oven-sh/bun/issues (exports condition / types)
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';

const require = createRequire(import.meta.url);

/** Packages that must be bundled and resolved to .js (not .d.ts). */
export const EXTENSION_BUNDLE_CORE_DEPS = ['hono', 'zod', 'kysely', '@hono/zod-validator'] as const;

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
  // `require.resolve(`${pkg}/package.json`)` can hit nested package.json files
  // (e.g. hono/dist/types/package.json) because of subpath exports. Walk up
  // from the resolved entry until we find the real package root by `name`.
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

/** Bun plugin: bare imports of core deps → package ESM .js entry (skip .d.ts). */
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

export interface ExtensionBundleOptions {
  entry: string;
  outfile: string;
  /** Package names to leave external (allow-listed peer deps). */
  external: string[];
  sourcemap?: boolean;
  /** Extension root — used for node_modules resolution. */
  resolveDir: string;
}

/**
 * Bundle `entry` → `outfile` using Bun.build with the types-safe resolve plugin.
 */
export async function bundleExtensionEngine(opts: ExtensionBundleOptions): Promise<void> {
  const outdir = dirname(opts.outfile);
  const entryBase = basename(opts.entry).replace(/\.[^.]+$/, '');
  const builtPath = join(outdir, `${entryBase}.js`);

  const result = await Bun.build({
    entrypoints: [opts.entry],
    outdir,
    naming: `${entryBase}.[ext]`,
    target: 'bun',
    format: 'esm',
    sourcemap: opts.sourcemap ? 'linked' : 'none',
    external: opts.external,
    conditions: [...BUNDLE_CONDITIONS],
    plugins: [createExtensionBundleResolvePlugin(opts.resolveDir)],
  });

  if (!result.success) {
    const messages = result.logs.map((l) => l.message).join('\n');
    throw new Error(messages || 'Bun.build failed');
  }

  if (!existsSync(builtPath)) {
    throw new Error(`Bun.build succeeded but ${builtPath} was not produced`);
  }

  if (builtPath !== opts.outfile) {
    renameSync(builtPath, opts.outfile);
  }
}
