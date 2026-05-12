<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Search, Plus, X, RefreshCw, Trash2, LoaderCircle } from '@lucide/svelte';

  let query = $state('');
  let selectedCollection = $state('');
  let results = $state<any[]>([]);
  let collections = $state<string[]>([]);
  let indexes = $state<any[]>([]);
  let loading = $state(false);
  let indexesLoading = $state(true);
  let searchError = $state<string | null>(null);
  let syncing = $state<string | null>(null);

  let showConfigModal = $state(false);
  let configCollection = $state('');
  let configProvider = $state<'meilisearch' | 'typesense'>('meilisearch');
  let configIndexName = $state('');
  let configSearchable = $state('');
  let configFilterable = $state('');
  let configSortable = $state('');
  let configSaving = $state(false);

  let resultColumns = $derived<string[]>(
    results.length > 0 ? Object.keys((results[0]?.hits?.[0] ?? results[0]) as Record<string, unknown>).slice(0, 8) : [],
  );

  function getResultRows(): any[] {
    if (!results.length) return [];
    const first = results[0];
    if (first?.hits) return first.hits.map((h: any) => h.document ?? h);
    return results;
  }

  async function search() {
    if (!query.trim() || !selectedCollection) return;
    loading = true; searchError = null;
    try {
      const res = await api.get(`/extensions/search/search?q=${encodeURIComponent(query)}&collection=${encodeURIComponent(selectedCollection)}&limit=50`);
      results = [res.results];
    } catch (e: any) { searchError = e.message ?? 'Search failed'; results = []; }
    finally { loading = false; }
  }

  async function syncIndex(collection: string) {
    syncing = collection;
    try {
      await api.post(`/extensions/search/indexes/${encodeURIComponent(collection)}/sync`, {});
      toast.success(`Sync started for "${collection}".`);
    } catch (e: any) { toast.error('Sync failed: ' + (e.message ?? '')); }
    finally { syncing = null; }
  }

  async function removeIndex(collection: string) {
    if (!confirm(`Remove search index for "${collection}"?`)) return;
    try {
      await api.delete(`/extensions/search/indexes/${encodeURIComponent(collection)}`);
      indexes = indexes.map((idx) => idx.collection === collection ? { ...idx, status: 'inactive' } : idx);
    } catch (e: any) { toast.error('Failed: ' + (e.message ?? '')); }
  }

  async function saveConfig() {
    if (!configCollection || !configIndexName) { toast.error('Collection and index name are required'); return; }
    configSaving = true;
    try {
      await api.post('/extensions/search/indexes', {
        collection: configCollection,
        provider: configProvider,
        index_name: configIndexName,
        searchable_fields: configSearchable.split(',').map((s) => s.trim()).filter(Boolean),
        filterable_fields: configFilterable.split(',').map((s) => s.trim()).filter(Boolean),
        sortable_fields: configSortable.split(',').map((s) => s.trim()).filter(Boolean),
      });
      showConfigModal = false;
      await loadIndexes();
      toast.success('Index configured.');
    } catch (e: any) { toast.error('Failed: ' + (e.message ?? '')); }
    finally { configSaving = false; }
  }

  function openConfigModal(col = '') {
    configCollection = col;
    configProvider = 'meilisearch';
    configIndexName = col || '';
    configSearchable = ''; configFilterable = ''; configSortable = '';
    showConfigModal = true;
  }

  async function loadIndexes() {
    const res = await api.get<{ indexes: any[] }>('/extensions/search/indexes');
    indexes = res.indexes ?? [];
  }

  onMount(async () => {
    try {
      const colRes = await api.get<{ collections: any[] }>('/api/collections');
      collections = (colRes.collections ?? []).map((c: any) => c.name);
      if (collections.length > 0) selectedCollection = collections[0];
    } catch {}
    try { await loadIndexes(); } catch {}
    indexesLoading = false;
  });

  function providerBadge(p: string) { return p === 'meilisearch' ? 'badge-warning' : 'badge-info'; }
  function statusBadge(s: string) { return s === 'active' ? 'badge-success' : 'badge-ghost'; }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-xl font-semibold flex items-center gap-2"><Search size={20} /> Search Adapter</h1>
    <p class="text-sm text-base-content/50">Configure indexes and run searches</p>
  </div>

  <div class="card bg-base-200 border border-base-300">
    <div class="card-body p-4 gap-3">
      <h2 class="font-medium text-sm">Search</h2>
      <div class="flex gap-2">
        <select bind:value={selectedCollection} class="select select-sm min-w-40">
          <option value="">Select collection</option>
          {#each collections as col}<option value={col}>{col}</option>{/each}
        </select>
        <input type="search" class="input input-sm flex-1" bind:value={query} placeholder="Search…" onkeydown={(e) => e.key === 'Enter' && search()} />
        <button class="btn btn-primary btn-sm" onclick={search} disabled={loading || !selectedCollection || !query.trim()}>
          {#if loading}<LoaderCircle size={14} class="animate-spin" />{:else}<Search size={14} />{/if}
        </button>
      </div>
      {#if searchError}<div class="text-error text-sm">{searchError}</div>{/if}
      {#if getResultRows().length > 0}
        <div>
          <p class="text-xs text-base-content/60 mb-2">{getResultRows().length} results</p>
          <div class="overflow-x-auto">
            <table class="table table-xs">
              <thead><tr>{#each resultColumns as col}<th>{col}</th>{/each}</tr></thead>
              <tbody>
                {#each getResultRows() as row, idx (idx)}
                  <tr>{#each resultColumns as col}<td class="max-w-xs truncate">{row[col] ?? '—'}</td>{/each}</tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {:else if !loading && query && selectedCollection}
        <p class="text-sm text-base-content/50">No results found.</p>
      {/if}
    </div>
  </div>

  <div>
    <div class="flex items-center justify-between mb-3">
      <h2 class="font-medium text-sm">Search Indexes</h2>
      <button class="btn btn-primary btn-sm gap-1" onclick={() => openConfigModal()}><Plus size={14} /> Configure Index</button>
    </div>

    {#if indexesLoading}
      <div class="flex justify-center py-8"><LoaderCircle size={24} class="animate-spin text-primary" /></div>
    {:else if indexes.length === 0}
      <div class="card bg-base-200">
        <div class="card-body items-center py-10 text-base-content/50 text-sm">
          No search indexes configured.
          <button class="btn btn-primary btn-sm mt-3" onclick={() => openConfigModal()}>Configure your first index</button>
        </div>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Collection</th><th>Provider</th><th>Index Name</th><th>Status</th><th>Records</th><th>Last Synced</th><th></th></tr></thead>
          <tbody>
            {#each indexes as idx}
              <tr class="hover">
                <td class="font-medium text-sm">{idx.collection}</td>
                <td><span class="badge {providerBadge(idx.provider)} badge-sm">{idx.provider}</span></td>
                <td class="font-mono text-xs">{idx.index_name}</td>
                <td><span class="badge {statusBadge(idx.status)} badge-sm">{idx.status}</span></td>
                <td class="text-sm">{(idx.record_count ?? 0).toLocaleString()}</td>
                <td class="text-xs text-base-content/60">{idx.last_synced_at ? new Date(idx.last_synced_at).toLocaleString() : 'Never'}</td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-ghost btn-xs gap-1" onclick={() => syncIndex(idx.collection)} disabled={syncing === idx.collection}>
                      {#if syncing === idx.collection}<LoaderCircle size={12} class="animate-spin" />{:else}<RefreshCw size={12} />{/if}
                    </button>
                    <button class="btn btn-ghost btn-xs" onclick={() => openConfigModal(idx.collection)}>Edit</button>
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => removeIndex(idx.collection)}><Trash2 size={12} /></button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>

{#if showConfigModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">Configure Search Index</h3><button class="btn btn-ghost btn-xs" onclick={() => (showConfigModal = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Collection</span></label>
          <select class="select select-sm" bind:value={configCollection}>
            <option value="">Select collection</option>
            {#each collections as col}<option value={col}>{col}</option>{/each}
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Provider</span></label>
          <select class="select select-sm" bind:value={configProvider}>
            <option value="meilisearch">MeiliSearch</option>
            <option value="typesense">Typesense</option>
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Index Name</span></label><input class="input input-sm font-mono" bind:value={configIndexName} placeholder="my_collection" /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Searchable Fields (comma-separated)</span></label><input class="input input-sm" bind:value={configSearchable} placeholder="name, description, title" /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Filterable Fields</span></label><input class="input input-sm" bind:value={configFilterable} placeholder="status, category" /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Sortable Fields</span></label><input class="input input-sm" bind:value={configSortable} placeholder="created_at, name" /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showConfigModal = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" onclick={saveConfig} disabled={configSaving}>
          {#if configSaving}<LoaderCircle size={13} class="animate-spin" />{/if} Save
        </button>
      </div>
    </div>
  </div>
{/if}
