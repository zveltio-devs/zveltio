<script lang="ts">
  import { sync } from '$lib/zveltio';
  import { WifiOff, RefreshCw } from '@lucide/svelte';

  let isOnline = $state(true);
  let pendingCount = $state(0);

  $effect(() => {
    if (typeof window === 'undefined') return;

    const update = () => { isOnline = navigator.onLine; };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    isOnline = navigator.onLine;

    // Poll pending sync count via LocalStore getPendingOps()
    const interval = setInterval(async () => {
      try {
        const ops = await (sync as any).store?.getPendingOps?.() ?? [];
        pendingCount = ops.length;
      } catch {
        pendingCount = 0;
      }
    }, 3000);

    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      clearInterval(interval);
    };
  });
</script>

{#if !isOnline}
  <div class="alert alert-warning shadow-lg rounded-none text-sm">
    <WifiOff size={16} />
    <span>You're offline. {pendingCount > 0 ? `${pendingCount} changes pending sync.` : 'Changes will sync when reconnected.'}</span>
  </div>
{:else if pendingCount > 0}
  <div class="alert alert-info shadow-lg rounded-none text-sm">
    <RefreshCw size={16} class="animate-spin" />
    <span>Syncing {pendingCount} pending changes...</span>
  </div>
{/if}
