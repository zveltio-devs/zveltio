<script lang="ts">
  import { onMount } from 'svelte';
  import { Bookmark, Play, Trash2, Plus, Share2, X } from '@lucide/svelte';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';

  const engineUrl = (import.meta as any).env?.PUBLIC_ENGINE_URL ?? '';

  // ── State ────────────────────────────────────────────────────────────────────
  let queries = $state<any[]>([]);
  let collections = $state<string[]>([]);
  let loading = $state(true);
  let filterCollection = $state('');
  let filterOwner = $state<'all' | 'mine' | 'shared'>('all');

  // Builder state
  let showBuilder = $state(false);
  let builderCollection = $state('');
  let builderName = $state('');
  let builderDescription = $state('');
  let builderIsShared = $state(false);
  let builderFilters = $state<Array<{ field: string; operator: string; value: string }>>([]);
  let builderSorts = $state<Array<{ field: string; direction: 'asc' | 'desc' }>>([]);
  let builderColumns = $state('');
  let builderLimit = $state(50);
  let builderPage = $state(1);
  let builderMode = $state<'AND' | 'OR'>('AND');


  let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

  // Split-view state
  let activeQuery = $state<any>(null);
  let queryResults = $state<any>(null);
  let running = $state(false);

  // Inline execute (no save)
  let executeResult = $state<any>(null);
  let executeError = $state('');
  let executing = $state(false);
  let apiUrlPreview = $state('');

  onMount(async () => {
    await Promise.all([loadQueries(), loadCollections()]);
  });

  async function loadQueries() {
    loading = true;
    const params = new URLSearchParams();
    if (filterCollection) params.set('collection', filterCollection);
    const res = await fetch(`${engineUrl}/api/saved-queries?${params}`, { credentials: 'include' }).then(r => r.json());
    queries = res.queries ?? [];
    loading = false;
  }

  async function loadCollections() {
    const res = await fetch(`${engineUrl}/api/collections`, { credentials: 'include' }).then(r => r.json());
    collections = (res.collections ?? []).map((c: any) => c.name);
  }

  // ── Computed filter ───────────────────────────────────────────────────────────
  let filtered = $derived(queries.filter(q => {
    if (filterOwner === 'mine' && !q.is_owner) return false;
    if (filterOwner === 'shared' && !q.is_shared) return false;
    if (filterCollection && q.collection !== filterCollection) return false;
    return true;
  }));

  // ── API URL preview ───────────────────────────────────────────────────────────
  async function previewUrl() {
    if (!builderCollection) return;
    const res = await fetch(`${engineUrl}/api/saved-queries/preview-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ collection: builderCollection, config: buildConfig() }),
    }).then(r => r.json());
    apiUrlPreview = res.api_url ?? '';
  }

  function buildConfig() {
    return {
      filters: builderFilters,
      filter_mode: builderMode,
      filter_groups: [],
      columns: builderColumns ? builderColumns.split(',').map(s => s.trim()).filter(Boolean) : [],
      sorts: builderSorts,
      limit: builderLimit,
      page: builderPage,
    };
  }

  // ── Execute without saving ────────────────────────────────────────────────────
  async function executeNow() {
    if (!builderCollection) return;
    executing = true;
    executeError = '';
    executeResult = null;
    const res = await fetch(`${engineUrl}/api/saved-queries/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ collection: builderCollection, config: buildConfig() }),
    }).then(r => r.json());
    if (res.error) executeError = res.error;
    else executeResult = res;
    executing = false;
  }

  // ── Save query ────────────────────────────────────────────────────────────────
  async function saveQuery() {
    if (!builderCollection || !builderName) return;
    await fetch(`${engineUrl}/api/saved-queries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        name: builderName,
        description: builderDescription || undefined,
        collection: builderCollection,
        config: buildConfig(),
        is_shared: builderIsShared,
      }),
    });
    resetBuilder();
    await loadQueries();
  }

  function resetBuilder() {
    showBuilder = false;
    builderName = '';
    builderDescription = '';
    builderCollection = '';
    builderIsShared = false;
    builderFilters = [];
    builderSorts = [];
    builderColumns = '';
    builderLimit = 50;
    builderPage = 1;
    builderMode = 'AND';
    executeResult = null;
    executeError = '';
    apiUrlPreview = '';
  }

  // ── Delete ────────────────────────────────────────────────────────────────────
  async function deleteQuery(id: string) {
    confirmState = {
      open: true,
      title: 'Delete Query',
      message: 'Delete this saved query?',
      confirmLabel: 'Delete',
      onconfirm: async () => {
        confirmState.open = false;
        await fetch(`${engineUrl}/api/saved-queries/${id}`, { method: 'DELETE', credentials: 'include' });
        await loadQueries();
      },
    };
  }

  // ── Split-view helpers ────────────────────────────────────────────────────────
  function selectQuery(q: any) { activeQuery = { ...q }; queryResults = null; }
  function newQuery() { activeQuery = { id: null, name: 'Untitled', sql: '' }; queryResults = null; }

  async function runActiveQuery() {
    if (!activeQuery) return;
    running = true;
    queryResults = null;
    try {
      if (activeQuery.id) {
        const res = await fetch(`${engineUrl}/api/saved-queries/${activeQuery.id}/run`, {
          method: 'POST', credentials: 'include',
        }).then(r => r.json());
        queryResults = { rows: res.records ?? [], columns: res.records?.length ? Object.keys(res.records[0]) : [] };
      }
    } finally {
      running = false;
    }
  }

  async function saveActiveQuery() {
    if (!activeQuery) return;
    if (activeQuery.id) {
      await fetch(`${engineUrl}/api/saved-queries/${activeQuery.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: activeQuery.name }),
      });
    }
    await loadQueries();
  }

  // ── Copy API URL ──────────────────────────────────────────────────────────────
  // ── Filter helpers ────────────────────────────────────────────────────────────
  const OPERATORS = ['equals','not_equals','contains','not_contains','starts_with','ends_with','gt','lt','gte','lte','is_null','is_not_null','is_true','is_false'];

  function addFilter() { builderFilters = [...builderFilters, { field: '', operator: 'equals', value: '' }]; }
  function removeFilter(i: number) { builderFilters = builderFilters.filter((_, idx) => idx !== i); }
  function addSort() { builderSorts = [...builderSorts, { field: '', direction: 'asc' }]; }
  function removeSort(i: number) { builderSorts = builderSorts.filter((_, idx) => idx !== i); }
</script>

<div class="space-y-6">
  <!-- Header -->
  <PageHeader title="Saved Queries" subtitle="Reusable SQL query templates">
    <button class="btn btn-primary btn-sm gap-2" onclick={() => (showBuilder = !showBuilder)}>
      <Plus size={16} />
      New Query
    </button>
  </PageHeader>

  <!-- Query Builder -->
  {#if showBuilder}
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body space-y-4">
        <h2 class="font-semibold text-lg">Query Builder</h2>

        <!-- Collection + Name -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div class="form-control">
            <div class="label py-0"><span class="label-text text-xs">Collection *</span></div>
            <select class="select select-sm" bind:value={builderCollection} onchange={previewUrl}>
              <option value="">Select collection</option>
              {#each collections as c}<option value={c}>{c}</option>{/each}
            </select>
          </div>
          <div class="form-control">
            <div class="label py-0"><span class="label-text text-xs">Query name *</span></div>
            <input class="input input-sm" type="text" placeholder="e.g. Active orders" bind:value={builderName} />
          </div>
          <div class="form-control">
            <div class="label py-0"><span class="label-text text-xs">Description</span></div>
            <input class="input input-sm" type="text" placeholder="Optional" bind:value={builderDescription} />
          </div>
        </div>

        <!-- Columns + Limit + Mode -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div class="form-control">
            <div class="label py-0"><span class="label-text text-xs">Columns (comma-separated, empty = all)</span></div>
            <input class="input input-sm" type="text" placeholder="id, name, status" bind:value={builderColumns} />
          </div>
          <div class="form-control">
            <div class="label py-0"><span class="label-text text-xs">Limit</span></div>
            <input class="input input-sm" type="number" min="1" max="1000" bind:value={builderLimit} />
          </div>
          <div class="form-control">
            <div class="label py-0"><span class="label-text text-xs">Filter mode</span></div>
            <select class="select select-sm" bind:value={builderMode}>
              <option value="AND">AND (all conditions)</option>
              <option value="OR">OR (any condition)</option>
            </select>
          </div>
        </div>

        <!-- Filters -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">Filters</span>
            <button class="btn btn-xs btn-ghost gap-1" onclick={addFilter}><Plus size={12} /> Add filter</button>
          </div>
          {#each builderFilters as f, i}
            <div class="flex gap-2 items-center">
              <input class="input input-xs flex-1" type="text" placeholder="field" bind:value={f.field} />
              <select class="select select-xs" bind:value={f.operator}>
                {#each OPERATORS as op}<option value={op}>{op}</option>{/each}
              </select>
              {#if !['is_null','is_not_null','is_true','is_false'].includes(f.operator)}
                <input class="input input-xs flex-1" type="text" placeholder="value" bind:value={f.value} />
              {/if}
              <button class="btn btn-xs btn-ghost btn-error" onclick={() => removeFilter(i)}><X size={12} /></button>
            </div>
          {/each}
        </div>

        <!-- Sorts -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">Sort</span>
            <button class="btn btn-xs btn-ghost gap-1" onclick={addSort}><Plus size={12} /> Add sort</button>
          </div>
          {#each builderSorts as s, i}
            <div class="flex gap-2 items-center">
              <input class="input input-xs flex-1" type="text" placeholder="field" bind:value={s.field} />
              <select class="select select-xs" bind:value={s.direction}>
                <option value="asc">ASC</option>
                <option value="desc">DESC</option>
              </select>
              <button class="btn btn-xs btn-ghost btn-error" onclick={() => removeSort(i)}><X size={12} /></button>
            </div>
          {/each}
        </div>

        <!-- API URL Preview -->
        {#if apiUrlPreview}
          <div class="bg-base-300 rounded px-3 py-2 text-xs font-mono text-base-content/70">{apiUrlPreview}</div>
        {/if}

        <!-- Execute result -->
        {#if executeResult}
          <div class="overflow-x-auto max-h-48 text-xs border border-base-300 rounded">
            <table class="table table-xs">
              <thead>
                <tr>{#each Object.keys(executeResult.records?.[0] ?? {}) as col}<th>{col}</th>{/each}</tr>
              </thead>
              <tbody>
                {#each executeResult.records as row}
                  <tr>{#each Object.values(row) as val}<td>{String(val ?? '')}</td>{/each}</tr>
                {/each}
              </tbody>
            </table>
            <p class="p-2 text-base-content/50">Total: {executeResult.pagination?.total ?? 0}</p>
          </div>
        {/if}
        {#if executeError}<p class="text-error text-xs">{executeError}</p>{/if}

        <!-- Shared toggle -->
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="checkbox checkbox-sm" bind:checked={builderIsShared} />
          <span class="text-sm"><Share2 size={12} class="inline mr-1" />Share with all users</span>
        </label>

        <!-- Actions -->
        <div class="flex gap-2 justify-end">
          <button class="btn btn-ghost btn-sm" onclick={resetBuilder}>Cancel</button>
          <button class="btn btn-outline btn-sm gap-1" onclick={executeNow} disabled={!builderCollection || executing}>
            {#if executing}<span class="loading loading-spinner loading-xs"></span>{:else}<Play size={14} />{/if}
            Test
          </button>
          <button class="btn btn-primary btn-sm gap-1" onclick={saveQuery} disabled={!builderCollection || !builderName}>
            <Bookmark size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Filters bar -->
  <div class="flex flex-wrap gap-3 items-end">
    <div class="form-control">
      <div class="label py-0"><span class="label-text text-xs">Collection</span></div>
      <select class="select select-sm w-40" bind:value={filterCollection} onchange={loadQueries}>
        <option value="">All collections</option>
        {#each collections as c}<option value={c}>{c}</option>{/each}
      </select>
    </div>
    <div class="join">
      {#each (['all','mine','shared'] as const) as o}
        <button class="join-item btn btn-sm {filterOwner === o ? 'btn-active' : ''}" onclick={() => (filterOwner = o)}>
          {o === 'all' ? 'All' : o === 'mine' ? 'Mine' : 'Shared'}
        </button>
      {/each}
    </div>
  </div>

  <!-- Split-view: list left + editor right -->
  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner"></span></div>
  {:else}
    <div class="flex gap-0 h-[calc(100vh-160px)] -mx-6 border-t border-base-200">
      <!-- Query list (left panel) -->
      <div class="w-64 shrink-0 flex flex-col border-r border-base-200">
        <div class="p-3 border-b border-base-200 flex items-center justify-between">
          <span class="text-sm font-medium">Saved Queries</span>
          <button class="btn btn-ghost btn-xs" onclick={newQuery}>+</button>
        </div>
        <div class="flex-1 overflow-y-auto">
          {#each filtered as q}
            <button class="w-full text-left px-3 py-2.5 border-b border-base-200/50 hover:bg-base-200 transition-colors
                           {activeQuery?.id === q.id ? 'bg-primary/8 border-l-2 border-l-primary' : ''}"
                    onclick={() => selectQuery(q)}>
              <div class="text-sm font-medium truncate">{q.name}</div>
              <div class="text-xs text-base-content/40 font-mono truncate mt-0.5">{(q.sql || q.query || q.collection || '').slice(0, 40)}...</div>
            </button>
          {/each}
          {#if filtered.length === 0}
            <div class="text-xs text-base-content/30 text-center py-8">No saved queries</div>
          {/if}
        </div>
      </div>

      <!-- Editor + results (right panel) -->
      <div class="flex-1 flex flex-col min-w-0">
        {#if activeQuery}
          <div class="flex items-center gap-2 px-4 py-2 border-b border-base-200 shrink-0">
            <span class="text-sm font-medium truncate flex-1">{activeQuery.name}</span>
            {#if activeQuery.collection}
              <span class="badge badge-ghost badge-xs">{activeQuery.collection}</span>
            {/if}
            <button class="btn btn-ghost btn-sm gap-1" onclick={runActiveQuery} disabled={running}>
              {#if running}<span class="loading loading-spinner loading-xs"></span>{:else}▶{/if} Run
            </button>
            <button class="btn btn-primary btn-sm" onclick={saveActiveQuery}>Save</button>
            {#if activeQuery.id && activeQuery.is_owner}
              <button class="btn btn-ghost btn-sm btn-error" onclick={() => deleteQuery(activeQuery.id)}>
                <Trash2 size={14} />
              </button>
            {/if}
          </div>
          <!-- Query info (read-only for filter-based queries) -->
          <div class="flex-1 overflow-auto p-4 bg-base-50 border-b border-base-200 min-h-0">
            {#if activeQuery.config}
              <div class="space-y-2">
                <div class="text-xs text-base-content/50 font-medium uppercase tracking-wide">Collection</div>
                <div class="font-mono text-sm">{activeQuery.collection}</div>
                <div class="text-xs text-base-content/50 font-medium uppercase tracking-wide mt-3">Config</div>
                <pre class="text-xs font-mono bg-base-200 rounded p-3 overflow-auto">{JSON.stringify(activeQuery.config, null, 2)}</pre>
              </div>
            {:else}
              <textarea class="w-full h-full font-mono text-xs resize-none outline-none bg-transparent"
                        bind:value={activeQuery.sql}
                        placeholder="-- SQL query..."></textarea>
            {/if}
          </div>
          {#if queryResults}
            <div class="shrink-0 max-h-48 overflow-auto border-t border-base-200">
              {#if queryResults.rows?.length > 0}
                <table class="table table-xs w-full">
                  <thead><tr>{#each queryResults.columns ?? Object.keys(queryResults.rows[0]) as col}<th>{col}</th>{/each}</tr></thead>
                  <tbody>{#each queryResults.rows as row}<tr>{#each queryResults.columns ?? Object.keys(row) as col}<td class="font-mono text-xs">{row[col] ?? '—'}</td>{/each}</tr>{/each}</tbody>
                </table>
              {:else}
                <div class="p-3 text-xs text-base-content/50">No results</div>
              {/if}
            </div>
          {/if}
        {:else}
          <div class="flex-1 flex items-center justify-center text-base-content/30 text-sm">
            Select a query or create a new one
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
