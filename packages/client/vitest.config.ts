/**
 * Vitest config for the public client host.
 *
 * Mirrors the studio setup: Vitest shares Vite's pipeline so Svelte 5
 * components + runes + the `$lib` alias work in tests, jsdom provides DOM
 * globals, and svelteTesting() resolves Svelte's client build + auto-cleans
 * the DOM between tests.
 *
 * Run:  bun run test   /   bun run test:watch
 */

import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [svelte({ hot: false }), svelteTesting()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      // `sveltekit()` is not in this pipeline, so nothing provides the `$app/*`
      // modules a route loader imports. Pointed at a stub the tests override
      // with `vi.mock`, so a loader can be exercised without booting the app.
      $app: fileURLToPath(new URL('./tests/app-stubs', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.svelte.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '.svelte-kit/**'],
    css: false,
  },
});
