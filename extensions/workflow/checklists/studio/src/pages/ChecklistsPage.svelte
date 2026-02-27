<script lang="ts">
  import { onMount } from 'svelte';

  const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

  // This page shows active checklist instances across all records
  let checklists = $state<any[]>([]);
  let loading = $state(true);
  let filter = $state<'all' | 'active' | 'completed'>('all');

  // We fetch using a custom summary endpoint; for now show recent checklists
  onMount(async () => {
    await loadSummary();
  });

  async function loadSummary() {
    loading = true;
    try {
      // Fetch recent checklist instances from engine
      // In production this would be a summary/dashboard endpoint
      // For now we use a simple query with a broad collection filter
      const res = await fetch(`${engineUrl}/api/checklists/summary`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        checklists = data.checklists || [];
      }
    } finally {
      loading = false;
    }
  }

  const filtered = $derived(
    filter === 'all'
      ? checklists
      : filter === 'completed'
      ? checklists.filter((c) => c.completed_at)
      : checklists.filter((c) => !c.completed_at)
  );

  function progress(cl: any): number {
    if (!cl.items || cl.items.length === 0) return 0;
    const checked = cl.items.filter((i: any) => i.checked).length;
    return Math.round((checked / cl.items.length) * 100);
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold">Checklists</h1>
    <p class="text-base-content/60 text-sm mt-1">Track checklist completion across records</p>
  </div>

  <div class="tabs tabs-boxed w-fit">
    <button class="tab {filter === 'all' ? 'tab-active' : ''}" onclick={() => (filter = 'all')}>All</button>
    <button class="tab {filter === 'active' ? 'tab-active' : ''}" onclick={() => (filter = 'active')}>Active</button>
    <button class="tab {filter === 'completed' ? 'tab-active' : ''}" onclick={() => (filter = 'completed')}>Completed</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else if filtered.length === 0}
    <div class="card bg-base-200 text-center py-12">
      <p class="text-base-content/60">No checklists found</p>
      <p class="text-sm text-base-content/40 mt-2">Checklists are attached to individual records from the data view</p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each filtered as cl}
        <div class="card bg-base-200">
          <div class="card-body p-4">
            <div class="flex items-start justify-between">
              <div class="flex-1">
                <div class="flex items-center gap-2 mb-1">
                  <h3 class="font-semibold">{cl.name}</h3>
                  {#if cl.completed_at}
                    <span class="badge badge-success badge-sm">completed</span>
                  {/if}
                </div>
                <p class="text-sm text-base-content/60">
                  {cl.collection} / <code class="font-mono">{cl.record_id?.slice(0, 8)}...</code>
                </p>
                <div class="mt-2">
                  <div class="flex items-center gap-2">
                    <progress class="progress progress-primary flex-1" value={progress(cl)} max="100"></progress>
                    <span class="text-xs text-base-content/60 w-10 text-right">{progress(cl)}%</span>
                  </div>
                  <p class="text-xs text-base-content/40 mt-1">
                    {cl.items?.filter((i: any) => i.checked).length ?? 0} / {cl.items?.length ?? 0} items
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
