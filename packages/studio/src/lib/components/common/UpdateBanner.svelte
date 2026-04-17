<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUpCircle, X } from '@lucide/svelte';
  import { ENGINE_URL } from '$lib/config.js';

  let updateInfo = $state<{
    has_update: boolean;
    current: string;
    latest: string;
    release_url: string;
  } | null>(null);

  let dismissed = $state(false);

  onMount(async () => {
    const cacheKey = 'zveltio_update_check';
    const cached = localStorage.getItem(cacheKey);

    if (cached) {
      try {
        const { data, timestamp } = JSON.parse(cached);
        const age = Date.now() - timestamp;
        if (age < 24 * 60 * 60 * 1000) {
          updateInfo = data;
          return;
        }
      } catch { /* stale/corrupt cache */ }
    }

    try {
      // credentials: 'include' — /api/health/update-check is auth-gated since
      // the version-info endpoints were moved off public exposure.
      const res = await fetch(`${ENGINE_URL}/api/health/update-check`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        updateInfo = data as any;
        localStorage.setItem(
          cacheKey,
          JSON.stringify({ data, timestamp: Date.now() }),
        );
      }
    } catch { /* non-fatal */ }
  });
</script>

{#if updateInfo?.has_update && !dismissed}
  <div class="alert alert-info py-2 px-4 rounded-none flex items-center justify-between">
    <div class="flex items-center gap-2 text-sm">
      <ArrowUpCircle size={16} />
      <span>
        Zveltio <strong>v{updateInfo.latest}</strong> is available
        (current: v{updateInfo.current})
      </span>
      <a
        href={updateInfo.release_url}
        target="_blank"
        rel="noopener noreferrer"
        class="underline opacity-75 hover:opacity-100"
      >
        Release notes
      </a>
      <span class="opacity-50">→</span>
      <code class="bg-base-200 px-1 rounded text-xs">zveltio update</code>
    </div>
    <button
      class="btn btn-ghost btn-xs"
      onclick={() => (dismissed = true)}
    >
      <X size={14} />
    </button>
  </div>
{/if}
