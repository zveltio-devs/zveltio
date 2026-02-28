<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  interface Revision {
    id: string;
    action: 'create' | 'update' | 'delete';
    delta: Record<string, { from: any; to: any }> | null;
    user_id: string | null;
    user_name: string | null;
    user_email: string | null;
    created_at: string;
  }

  let { collection, recordId }: { collection: string; recordId: string } = $props();

  let revisions = $state<Revision[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let expanded = $state<string | null>(null);

  onMount(loadRevisions);

  async function loadRevisions() {
    loading = true;
    error = null;
    try {
      const data = await api.get<{ revisions: Revision[] }>(`/api/revisions/${collection}/${recordId}`);
      revisions = data.revisions || [];
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load';
    } finally {
      loading = false;
    }
  }

  async function revert(revisionId: string) {
    if (!confirm('Revert to this version? Current data will be overwritten.')) return;
    try {
      await api.post(`/api/revisions/${collection}/${recordId}/revert/${revisionId}`);
      window.location.reload();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to revert';
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function actionBadge(action: string) {
    const map: Record<string, string> = { create: 'badge-success', update: 'badge-warning', delete: 'badge-error' };
    return map[action] || 'badge-ghost';
  }
</script>

<div class="space-y-2">
  <h3 class="font-bold text-sm flex items-center gap-2 opacity-70">
    📜 Revision History ({revisions.length})
  </h3>

  {#if error}
    <div class="alert alert-error text-xs">⚠️ {error}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-4">
      <span class="loading loading-spinner loading-sm"></span>
    </div>
  {:else if revisions.length === 0}
    <p class="text-sm opacity-40 text-center py-4">No revisions recorded</p>
  {:else}
    {#each revisions as rev}
      <div class="border border-base-300 rounded-lg overflow-hidden">
        <div
          class="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-base-200"
          onclick={() => (expanded = expanded === rev.id ? null : rev.id)}
          onkeydown={(e) => e.key === 'Enter' && (expanded = expanded === rev.id ? null : rev.id)}
          role="button"
          tabindex="0"
        >
          <div class="flex items-center gap-2">
            <span class="text-xs">{expanded === rev.id ? '▼' : '▶'}</span>
            <div class="badge {actionBadge(rev.action)} badge-xs">{rev.action}</div>
            <span class="text-xs opacity-60">{formatDate(rev.created_at)}</span>
            <span class="text-xs font-medium">{rev.user_name || rev.user_email || 'System'}</span>
          </div>
          {#if rev.action !== 'delete'}
            <button
              class="btn btn-ghost btn-xs gap-1"
              onclick={(e) => { e.stopPropagation(); revert(rev.id); }}
              title="Revert to this version"
            >↩️ Revert</button>
          {/if}
        </div>

        {#if expanded === rev.id && rev.delta}
          <div class="px-3 py-2 bg-base-200 border-t border-base-300">
            <div class="space-y-1">
              {#each Object.entries(rev.delta) as [field, change]}
                <div class="grid grid-cols-3 gap-2 text-xs">
                  <span class="font-mono font-bold opacity-70">{field}</span>
                  <span class="bg-error/10 text-error px-1 rounded line-through">{JSON.stringify(change.from)}</span>
                  <span class="bg-success/10 text-success px-1 rounded">{JSON.stringify(change.to)}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
