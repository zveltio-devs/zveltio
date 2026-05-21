<script lang="ts">
  /**
   * Root error boundary. Catches any unhandled error thrown by:
   *   - +page.svelte, +page.ts, +layout.svelte, +layout.ts
   *   - or a SvelteKit load function
   *
   * SvelteKit walks up the route tree looking for the closest +error.svelte
   * — so this file is the safety net for everything that doesn't have its
   * own (admin/client/intranet each get their own too, see siblings).
   *
   * Why this exists: before this file, a runtime error in any page (a
   * stale fetch, a thrown promise, a Svelte 5 reactivity bug) would
   * render SvelteKit's default white-screen-of-text fallback. Users
   * couldn't recover without manually navigating home or refreshing.
   */
  import { page } from '$app/state';
  import { goto, invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import { AlertTriangle, Home, RotateCcw } from '@lucide/svelte';

  function retry() {
    // Re-run all load functions; if the page recovers, the error is cleared.
    invalidateAll();
  }
</script>

<div class="min-h-screen flex items-center justify-center p-4 bg-base-200">
  <div class="card bg-base-100 shadow-xl max-w-lg w-full">
    <div class="card-body items-center text-center gap-3">
      <div class="p-3 rounded-full bg-error/10">
        <AlertTriangle size={32} class="text-error" />
      </div>
      <h1 class="text-2xl font-bold">Something went wrong</h1>
      <p class="text-base-content/70">
        {page.status === 404 ? 'The page you were looking for does not exist.' : 'An unexpected error interrupted the page.'}
      </p>
      {#if page.error?.message}
        <pre class="text-xs bg-base-200 p-3 rounded w-full text-left whitespace-pre-wrap break-words max-h-40 overflow-auto">{page.error.message}</pre>
      {/if}
      <div class="flex flex-wrap gap-2 mt-4">
        <button class="btn btn-primary btn-sm gap-2" onclick={retry}>
          <RotateCcw size={14} /> Retry
        </button>
        <button class="btn btn-ghost btn-sm gap-2" onclick={() => goto(`${base}/`)}>
          <Home size={14} /> Go home
        </button>
      </div>
    </div>
  </div>
</div>
