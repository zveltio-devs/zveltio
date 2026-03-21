// hooks.client.ts — runs before anything else in the Studio browser bundle
// Exposes Svelte runtime on window so IIFE extension bundles can use it
// without bundling their own copy (which would cause "multiple Svelte instances" crashes)

import * as svelte from 'svelte';
import * as store from 'svelte/store';
import * as transition from 'svelte/transition';
import * as animate from 'svelte/animate';

// svelte/internal is not a public export in Svelte 5 — use empty fallback
let internal: Record<string, unknown> = {};
try {
  // @ts-ignore — may not exist in Svelte 5
  internal = await import('svelte/internal');
} catch { /* Svelte 5 removed svelte/internal — extensions should not rely on it */ }

if (typeof window !== 'undefined') {
  (window as any).__SvelteRuntime = { svelte, internal, store, transition, animate };
}

export {};
