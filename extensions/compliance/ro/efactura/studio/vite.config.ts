import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'ZveltioExt',
      formats: ['iife'],
      fileName: () => 'bundle.js',
    },
    rollupOptions: {
      external: ['svelte', 'svelte/internal', 'svelte/store', 'svelte/transition', 'svelte/animate'],
      output: {
        globals: {
          'svelte':            'window.__SvelteRuntime.svelte',
          'svelte/internal':   'window.__SvelteRuntime.internal',
          'svelte/store':      'window.__SvelteRuntime.store',
          'svelte/transition': 'window.__SvelteRuntime.transition',
          'svelte/animate':    'window.__SvelteRuntime.animate',
        },
      },
    },
    outDir: 'dist',
  },
});
