<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import AuditDiff from './AuditDiff.svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down.svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right.svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw.svelte';

  interface Revision {
    id: string;
    collection: string;
    record_id: string;
    action: 'create' | 'update' | 'delete';
    delta: Record<string, { from: any; to: any }> | null;
    user_id: string | null;
    user_name: string | null;
    user_email: string | null;
    created_at: string;
  }

  interface Props {
    collection?: string;
    recordId?: string;
    limit?: number;
  }

  let { collection, recordId, limit = 50 }: Props = $props();

  let revisions = $state<Revision[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let expanded = $state<Set<string>>(new Set());
  let page = $state(1);
  let total = $state(0);

  let filterCollection = $state(collection || '');
  let filterAction = $state('');

  onMount(load);

  async function load() {
    loading = true;
    error = null;
    try {
      let path = '/api/admin/revisions?';
      const params = new URLSearchParams({ limit: String(limit), page: String(page) });
      if (filterCollection) params.set('collection', filterCollection);
      if (filterAction) params.set('action', filterAction);
      if (recordId) params.set('record_id', recordId);
      const data = await api.get<{ revisions: Revision[]; total: number }>(`/api/admin/revisions?${params}`);
      revisions = data.revisions || [];
      total = data.total || 0;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load audit log';
    } finally {
      loading = false;
    }
  }

  function toggleExpand(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  const actionBadge: Record<string, string> = {
    create: 'badge-success', update: 'badge-warning', delete: 'badge-error',
  };
</script>

<div class="space-y-3">
  <!-- Filters -->
  <div class="flex flex-wrap gap-2 items-end">
    {#if !collection}
      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">Collection</span></label>
        <input type="text" class="input input-bordered input-xs w-36" placeholder="All"
          bind:value={filterCollection} onchange={load} />
      </div>
    {/if}
    <div class="form-control">
      <label class="label py-0"><span class="label-text text-xs">Action</span></label>
      <select class="select select-bordered select-xs w-28" bind:value={filterAction} onchange={load}>
        <option value="">All</option>
        <option value="create">Create</option>
        <option value="update">Update</option>
        <option value="delete">Delete</option>
      </select>
    </div>
    <button class="btn btn-xs btn-ghost gap-1" onclick={load}><RefreshCw size={12} /> Refresh</button>
    {#if total > 0}
      <span class="text-xs opacity-50 ml-auto">{total} entries</span>
    {/if}
  </div>

  {#if error}
    <div class="alert alert-error text-xs py-2">{error}</div>
  {:else if loading}
    <div class="flex justify-center py-6"><span class="loading loading-spinner loading-md"></span></div>
  {:else if revisions.length === 0}
    <div class="text-center py-8 opacity-40">
      <p class="text-sm">No audit entries found</p>
    </div>
  {:else}
    <div class="space-y-1">
      {#each revisions as rev}
        <div class="border border-base-300 rounded-lg overflow-hidden">
          <button
            class="w-full flex items-center justify-between px-3 py-2 hover:bg-base-200 transition-colors text-left"
            onclick={() => toggleExpand(rev.id)}
          >
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-xs opacity-50 shrink-0">
                {expanded.has(rev.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
              <span class="badge {actionBadge[rev.action] || 'badge-ghost'} badge-xs">{rev.action}</span>
              <span class="font-mono text-xs text-primary shrink-0">{rev.collection}</span>
              {#if !recordId}
                <span class="text-xs opacity-50 truncate">#{rev.record_id}</span>
              {/if}
            </div>
            <div class="flex items-center gap-3 shrink-0 ml-2">
              <span class="text-xs opacity-60">{rev.user_name || rev.user_email || 'System'}</span>
              <span class="text-xs opacity-40">{formatDate(rev.created_at)}</span>
            </div>
          </button>

          {#if expanded.has(rev.id)}
            <div class="px-3 py-2 bg-base-200 border-t border-base-300">
              <AuditDiff delta={rev.delta} compact={true} />
            </div>
          {/if}
        </div>
      {/each}
    </div>

    {#if total > limit}
      <div class="flex justify-center gap-2 mt-2">
        <button class="btn btn-xs btn-ghost" disabled={page === 1}
          onclick={() => { page--; load(); }}>← Prev</button>
        <span class="text-xs opacity-50 self-center">Page {page}</span>
        <button class="btn btn-xs btn-ghost" disabled={page * limit >= total}
          onclick={() => { page++; load(); }}>Next →</button>
      </div>
    {/if}
  {/if}
</div>
