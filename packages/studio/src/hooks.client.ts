// hooks.client.ts — runs before anything else in the Studio browser bundle
// Exposes Svelte runtime on window so IIFE extension bundles can use it
// without bundling their own copy (which would cause "multiple Svelte instances" crashes)

import * as svelte from 'svelte';
import * as store from 'svelte/store';
import * as transition from 'svelte/transition';
import * as animate from 'svelte/animate';
import * as reactivity from 'svelte/reactivity';
import * as internal_client from 'svelte/internal/client';

if (typeof window !== 'undefined') {
  (window as any).__SvelteRuntime = {
    svelte,
    store,
    transition,
    animate,
    reactivity,
    internal_client,
    // legacy alias — kept for any bundles that referenced it
    internal: internal_client,
  };
}

export {};
