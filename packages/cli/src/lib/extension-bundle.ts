/**
 * Bundle extension engine sources with Bun.build.
 *
 * The plugin + config logic lives in `@zveltio/sdk/build` so authors
 * with custom build scripts can use the same single source of truth.
 * This CLI module is the thin wrapper that calls Bun.build with that
 * config, does the post-build rename, and surfaces errors with the
 * publisher-facing message.
 */

import { existsSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  createExtensionBuildConfig,
  EXTENSION_BUNDLE_CORE_DEPS as _CORE,
} from '@zveltio/sdk/build';

// Re-export for the legacy import sites (extension-pack.ts).
export const EXTENSION_BUNDLE_CORE_DEPS = _CORE;

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
    ...createExtensionBuildConfig({
      entry: opts.entry,
      outdir,
      resolveDir: opts.resolveDir,
      external: opts.external,
      sourcemap: opts.sourcemap,
    }),
    naming: `${entryBase}.[ext]`,
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
