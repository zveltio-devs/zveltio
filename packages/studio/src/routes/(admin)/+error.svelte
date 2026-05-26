<script lang="ts">
/**
 * Admin-zone error boundary. Renders inside the admin shell so the user
 * stays oriented (sidebar visible, can navigate elsewhere) instead of
 * dropping into the root error page.
 *
 * Keeps SvelteKit's default behaviour: 404s and per-route load errors
 * surface here. Unhandled component-render errors bubble up to the
 * root +error.svelte fallback.
 */
import { page } from '$app/state';
import { goto, invalidateAll } from '$app/navigation';
import { base } from '$app/paths';
import { AlertTriangle, ArrowLeft, RotateCcw } from '@lucide/svelte';
</script>

<div class="flex items-center justify-center min-h-[60vh] p-6">
  <div class="max-w-lg w-full">
    <div class="card bg-base-100 border border-base-300">
      <div class="card-body items-center text-center gap-3 p-8">
        <div class="p-3 rounded-full bg-error/10">
          <AlertTriangle size={28} class="text-error" />
        </div>
        <h2 class="text-xl font-bold">
          {page.status === 404 ? 'Page not found' : 'Something went wrong'}
        </h2>
        <p class="text-sm text-base-content/60 max-w-md">
          {page.status === 404
            ? 'That URL does not match any admin page.'
            : 'This page hit an error while loading. Retry first; if it keeps failing, file a bug with the message below.'}
        </p>
        {#if page.error?.message && page.status !== 404}
          <pre class="text-xs bg-base-200 p-3 rounded w-full text-left whitespace-pre-wrap break-words max-h-40 overflow-auto font-mono">{page.error.message}</pre>
        {/if}
        <div class="flex flex-wrap gap-2 mt-2">
          <button class="btn btn-primary btn-sm gap-2" onclick={() => invalidateAll()}>
            <RotateCcw size={14} /> Retry
          </button>
          <button class="btn btn-ghost btn-sm gap-2" onclick={() => goto(`${base}/`)}>
            <ArrowLeft size={14} /> Back to dashboard
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
