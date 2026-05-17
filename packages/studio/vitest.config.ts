/**
 * Vitest config for Studio (S5-10).
 *
 * Vitest is configured to share Vite's pipeline so Svelte 5 components +
 * runes + path aliases ($lib, $app) just work in tests. jsdom provides
 * DOM globals for component-level testing; the `setup` file injects
 * @testing-library/jest-dom matchers (toBeInTheDocument, etc.) and a
 * SvelteKit module stub so any code that imports $app/* doesn't blow up.
 *
 * Why not Bun's built-in test runner: Bun + Svelte 5 runes have known
 * issues today (no working Svelte preprocessor for `bun test`). Vitest is
 * the path-of-least-resistance for component tests in a Svelte 5 + Vite
 * codebase.
 *
 * Run:
 *   bun run test         # all tests
 *   bun run test:watch   # interactive
 *   bun run test:ui      # browser UI
 */

import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    svelte({
      // Run the Svelte 5 compiler in "client" mode for tests — same
      // settings the production build uses, minus SSR-specific output.
      hot: false,
    }),
  ],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      // SvelteKit-only modules — stubbed in tests/setup.ts.
      '$app/paths': fileURLToPath(new URL('./tests/stubs/app-paths.ts', import.meta.url)),
      '$app/state': fileURLToPath(new URL('./tests/stubs/app-state.ts', import.meta.url)),
      '$app/navigation': fileURLToPath(new URL('./tests/stubs/app-navigation.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true, // expect, describe, it, etc. on the global object
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.svelte.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '.svelte-kit/**'],
    // Component tests sometimes touch globals that jsdom doesn't have
    // by default (e.g. ResizeObserver). Provide them in setup.ts.
    css: false, // skip CSS parsing — runtime tests don't need it
  },
});
