<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  let query = $state('');
  let selectedCollection = $state('');
  let results = $state<any[]>([]);
  let collections = $state<string[]>([]);
  let indexes = $state<any[]>([]);
  let loading = $state(false);
  let indexesLoading = $state(true);
  let searchError = $state<string | null>(null);
  let syncing = $state<string | null>(null);

  // Configure index modal
  let showConfigModal = $state(false);
  let configCollection = $state('');
  let configProvider = $state<'meilisearch' | 'typesense'>('meilisearch');
  let configIndexName = $state('');
  let configSearchable = $state('');
  let configFilterable = $state('');
  let configSortable = $state('');
  let configSaving = $state(false);

  // Dynamic result columns based on first result
  let resultColumns = $derived<string[]>(
    results.length > 0
      ? Object.keys(
          (results[0]?.hits?.[0] ?? results[0]) as Record<string, unknown>,
        ).slice(0, 8)
      : [],
  );

  function getResultRows(): any[] {
    if (!results.length) return [];
    // MeiliSearch returns { hits: [...] }, Typesense returns { hits: [{document: {...}}] }
    const first = results[0];
    if (first?.hits) {
      return first.hits.map((h: any) => h.document ?? h);
    }
    return results;
  }

  async function search() {
    if (!query.trim() || !selectedCollection) return;
    loading = true;
    searchError = null;
    try {
      const res = await api.get(
        `/extensions/search/search?q=${encodeURIComponent(query)}&collection=${encodeURIComponent(selectedCollection)}&limit=50`,
      );
      results = [res.results];
    } catch (e: any) {
      searchError = e.message ?? 'Search failed';
      results = [];
    } finally {
      loading = false;
    }
  }

  async function syncIndex(collection: string) {
    syncing = collection;
    try {
      await api.post(`/extensions/search/indexes/${encodeURIComponent(collection)}/sync`, {});
      alert(`Sync started for "${collection}". Refresh shortly to see updated count.`);
    } catch (e: any) {
      alert('Sync failed: ' + (e.message ?? ''));
    } finally {
      syncing = null;
    }
  }

  async function removeIndex(collection: string) {
    if (!confirm(`Remove search index for "${collection}"?`)) return;
    try {
      await api.delete(`/extensions/search/indexes/${encodeURIComponent(collection)}`);
      indexes = indexes.map((idx) =>
        idx.collection === collection ? { ...idx, status: 'inactive' } : idx,
      );
    } catch (e: any) {
      alert('Failed: ' + (e.message ?? ''));
    }
  }

  async function saveConfig() {
    if (!configCollection || !configIndexName) return alert('Collection and index name are required');
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
    } catch (e: any) {
      alert('Failed: ' + (e.message ?? ''));
    } finally {
      configSaving = false;
    }
  }

  function openConfigModal(col = '') {
    configCollection = col;
    configProvider = 'meilisearch';
    configIndexName = col || '';
    configSearchable = '';
    configFilterable = '';
    configSortable = '';
    showConfigModal = true;
  }

  async function loadIndexes() {
    const res = await api.get('/extensions/search/indexes');
    indexes = res.indexes ?? [];
  }

  onMount(async () => {
    try {
      const [colRes] = await Promise.all([
        api.get('/api/collections'),
      ]);
      collections = (colRes.collections ?? []).map((c: any) => c.name);
      if (collections.length > 0) selectedCollection = collections[0];
    } catch {
      // ignore
    }
    try {
      await loadIndexes();
    } catch {
      // ignore
    }
    indexesLoading = false;
  });
</script>

<div class="search-page">
  <h1>Search Adapter</h1>

  <!-- Search bar -->
  <section class="search-section">
    <div class="search-bar">
      <select bind:value={selectedCollection} class="collection-select">
        <option value="">Select collection</option>
        {#each collections as col}
          <option value={col}>{col}</option>
        {/each}
      </select>
      <input
        type="search"
        class="search-input"
        bind:value={query}
        placeholder="Search…"
        onkeydown={(e) => e.key === 'Enter' && search()}
      />
      <button class="btn-search" onclick={search} disabled={loading || !selectedCollection || !query.trim()}>
        {loading ? 'Searching…' : 'Search'}
      </button>
    </div>

    {#if searchError}
      <p class="error">{searchError}</p>
    {/if}

    {#if getResultRows().length > 0}
      <div class="results-table-wrap">
        <p class="result-count">{getResultRows().length} results</p>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                {#each resultColumns as col}
                  <th>{col}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each getResultRows() as row}
                <tr>
                  {#each resultColumns as col}
                    <td class="cell">{row[col] ?? '—'}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {:else if !loading && query && selectedCollection}
      <p class="no-results">No results found.</p>
    {/if}
  </section>

  <!-- Index management -->
  <section class="indexes-section">
    <div class="section-header">
      <h2>Search Indexes</h2>
      <button class="btn-configure" onclick={() => openConfigModal()}>+ Configure Index</button>
    </div>

    {#if indexesLoading}
      <p class="loading">Loading indexes…</p>
    {:else if indexes.length === 0}
      <div class="empty-state">
        <p>No search indexes configured yet.</p>
        <button class="btn-configure" onclick={() => openConfigModal()}>Configure your first index</button>
      </div>
    {:else}
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Collection</th>
              <th>Provider</th>
              <th>Index Name</th>
              <th>Status</th>
              <th>Records</th>
              <th>Last Synced</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each indexes as idx}
              <tr>
                <td class="collection-name">{idx.collection}</td>
                <td><span class="provider-badge provider-{idx.provider}">{idx.provider}</span></td>
                <td class="index-name"><code>{idx.index_name}</code></td>
                <td>
                  <span class="status-badge status-{idx.status}">{idx.status}</span>
                </td>
                <td>{(idx.record_count ?? 0).toLocaleString()}</td>
                <td class="time">
                  {idx.last_synced_at ? new Date(idx.last_synced_at).toLocaleString() : 'Never'}
                </td>
                <td>
                  <button
                    class="btn-sm btn-sync"
                    onclick={() => syncIndex(idx.collection)}
                    disabled={syncing === idx.collection}
                  >
                    {syncing === idx.collection ? 'Syncing…' : 'Sync'}
                  </button>
                  <button
                    class="btn-sm"
                    onclick={() => openConfigModal(idx.collection)}
                  >Edit</button>
                  <button
                    class="btn-sm btn-danger"
                    onclick={() => removeIndex(idx.collection)}
                  >Remove</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>

<!-- Configure Index Modal -->
{#if showConfigModal}
  <div class="modal-overlay" onclick={() => { showConfigModal = false; }}>
    <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <h2>Configure Search Index</h2>
      <div class="modal-form">
        <label>Collection
          <select bind:value={configCollection}>
            <option value="">Select collection</option>
            {#each collections as col}
              <option value={col}>{col}</option>
            {/each}
          </select>
        </label>
        <label>Provider
          <select bind:value={configProvider}>
            <option value="meilisearch">MeiliSearch</option>
            <option value="typesense">Typesense</option>
          </select>
        </label>
        <label>Index Name
          <input type="text" bind:value={configIndexName} placeholder="e.g. my_collection" />
        </label>
        <label>Searchable Fields (comma-separated)
          <input type="text" bind:value={configSearchable} placeholder="name, description, title" />
        </label>
        <label>Filterable Fields (comma-separated)
          <input type="text" bind:value={configFilterable} placeholder="status, category" />
        </label>
        <label>Sortable Fields (comma-separated)
          <input type="text" bind:value={configSortable} placeholder="created_at, name" />
        </label>
        <div class="modal-actions">
          <button class="btn-cancel" onclick={() => { showConfigModal = false; }}>Cancel</button>
          <button class="btn-save" onclick={saveConfig} disabled={configSaving}>
            {configSaving ? 'Saving…' : 'Save Index Config'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .search-page { max-width: 1200px; margin: 0 auto; padding: 2rem; }
  h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 1.5rem; }
  h2 { font-size: 1.25rem; font-weight: 600; }
  section { margin-bottom: 2.5rem; }
  .loading { color: #6b7280; }
  .error { color: #ef4444; margin-top: 0.5rem; }
  .no-results { color: #9ca3af; margin-top: 0.5rem; }
  .search-bar { display: flex; gap: 0.5rem; align-items: center; }
  .collection-select { padding: 0.5rem; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 0.875rem; min-width: 160px; }
  .search-input { flex: 1; padding: 0.5rem 0.75rem; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 0.875rem; }
  .search-input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px #6366f133; }
  .btn-search { padding: 0.5rem 1rem; background: #6366f1; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; }
  .btn-search:hover:not(:disabled) { background: #4f46e5; }
  .btn-search:disabled { opacity: 0.6; cursor: not-allowed; }
  .results-table-wrap { margin-top: 1rem; }
  .result-count { font-size: 0.875rem; color: #6b7280; margin-bottom: 0.5rem; }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .btn-configure { padding: 0.4rem 0.9rem; background: #6366f1; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.875rem; font-weight: 500; }
  .btn-configure:hover { background: #4f46e5; }
  .empty-state { text-align: center; padding: 2rem; color: #6b7280; }
  .empty-state p { margin-bottom: 1rem; }
  .table-wrapper { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th { text-align: left; padding: 0.6rem 0.75rem; background: #f9fafb; border-bottom: 2px solid #e5e7eb; font-weight: 600; color: #374151; }
  td { padding: 0.6rem 0.75rem; border-bottom: 1px solid #f3f4f6; }
  .cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .collection-name { font-weight: 500; }
  .index-name code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
  .provider-badge { padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
  .provider-meilisearch { background: #fef3c7; color: #d97706; }
  .provider-typesense { background: #dbeafe; color: #2563eb; }
  .status-badge { padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
  .status-active { background: #dcfce7; color: #16a34a; }
  .status-inactive { background: #f3f4f6; color: #6b7280; }
  .time { font-size: 0.8rem; color: #9ca3af; white-space: nowrap; }
  .btn-sm { padding: 0.25rem 0.6rem; border: 1px solid #e5e7eb; background: white; border-radius: 4px; cursor: pointer; font-size: 0.8rem; margin-right: 0.25rem; }
  .btn-sm:hover:not(:disabled) { background: #f9fafb; }
  .btn-sm:disabled { opacity: 0.6; cursor: not-allowed; }
  .btn-sync { border-color: #bfdbfe; color: #2563eb; }
  .btn-sync:hover:not(:disabled) { background: #eff6ff; }
  .btn-danger { border-color: #fca5a5; color: #dc2626; }
  .btn-danger:hover { background: #fef2f2; }
  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal { background: white; border-radius: 10px; padding: 1.5rem; width: 480px; max-width: 95vw; }
  .modal h2 { margin-bottom: 1rem; }
  .modal-form label { display: flex; flex-direction: column; gap: 4px; font-size: 0.875rem; font-weight: 500; color: #374151; margin-bottom: 0.75rem; }
  .modal-form input, .modal-form select { padding: 0.4rem 0.6rem; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 0.875rem; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
  .btn-cancel { padding: 0.4rem 0.9rem; background: white; border: 1px solid #e5e7eb; border-radius: 6px; cursor: pointer; }
  .btn-save { padding: 0.4rem 0.9rem; background: #6366f1; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; }
  .btn-save:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
