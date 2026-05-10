#!/usr/bin/env bun
/**
 * Bundles Svelte 5 runtime sub-modules into static/runtime/ so they can be
 * served to the browser and referenced by the import map in app.html.
 *
 * Extension IIFE bundles externalize 'svelte' and 'svelte/*' — the browser
 * resolves them via the import map to these files. All extensions share the
 * same Svelte instance (module cache), eliminating the "multiple Svelte
 * instances" freeze bug.
 *
 * Runs automatically via the "prebuild" script before `vite build`.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';

const STUDIO_ROOT = join(import.meta.dir, '..');
const SHIMS_DIR = join(STUDIO_ROOT, 'src', 'runtime-shims');
const OUT_DIR = join(STUDIO_ROOT, 'static', 'runtime');

mkdirSync(OUT_DIR, { recursive: true });

const ENTRIES: Record<string, string> = {
  svelte:                  join(SHIMS_DIR, 'svelte.ts'),
  'svelte-store':          join(SHIMS_DIR, 'svelte-store.ts'),
  'svelte-internal-client':join(SHIMS_DIR, 'svelte-internal-client.ts'),
  'svelte-transition':     join(SHIMS_DIR, 'svelte-transition.ts'),
  'svelte-animate':        join(SHIMS_DIR, 'svelte-animate.ts'),
  'svelte-reactivity':     join(SHIMS_DIR, 'svelte-reactivity.ts'),
};

console.log('Generating Svelte runtime bundles for import map…\n');

const result = await Bun.build({
  entrypoints: Object.values(ENTRIES),
  outdir: OUT_DIR,
  format: 'esm',
  target: 'browser',
  splitting: true,
  minify: true,
  naming: {
    entry: '[name].js',
    chunk: 'chunk-[hash].js',
    asset: '[name].[ext]',
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(`  ✓ ${output.path.replace(OUT_DIR, 'static/runtime')}`);
}

console.log('\nRuntime bundles ready.');
