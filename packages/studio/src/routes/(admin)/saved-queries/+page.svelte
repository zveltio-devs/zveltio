<script lang="ts">
  import { onMount } from 'svelte';
  import { Bookmark, Play, Trash2, Plus, Share2, Filter, ChevronDown, ChevronRight, Copy, Check, X } from '@lucide/svelte';

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

  // Results state
  let runningId = $state<string | null>(null);
  let results = $state<Record<string, { records: any[]; pagination: any; api_url: string }>>({});
  let expandedId = $state<string | null>(null);
  let copiedId = $state<string | null>(null);

  // Edit state
  let editingId = $state<string | null>(null);
  let editName = $state('');
  let editDescription = $state('');
  let editIsShared = $state(false);

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

  // ── Run saved query ───────────────────────────────────────────────────────────
  async function runQuery(q: any) {
    runningId = q.id;
    expandedId = q.id;
    const res = await fetch(`${engineUrl}/api/saved-queries/${q.id}/run`, {
      method: 'POST',
      credentials: 'include',
    }).then(r => r.json());
    results[q.id] = res;
    runningId = null;
  }

  // ── Delete ────────────────────────────────────────────────────────────────────
  async function deleteQuery(id: string) {
    if (!confirm('Delete this saved query?')) return;
    await fetch(`${engineUrl}/api/saved-queries/${id}`, { method: 'DELETE', credentials: 'include' });
    await loadQueries();
  }

  // ── Update ────────────────────────────────────────────────────────────────────
  async function updateQuery(id: string) {
    await fetch(`${engineUrl}/api/saved-queries/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: editName, description: editDescription, is_shared: editIsShared }),
    });
    editingId = null;
    await loadQueries();
  }

  function startEdit(q: any) {
    editingId = q.id;
    editName = q.name;
    editDescription = q.description ?? '';
    editIsShared = q.is_shared;
  }

  // ── Copy API URL ──────────────────────────────────────────────────────────────
  function copyUrl(q: any) {
    const res = results[q.id];
    const url = res?.api_url ?? '';
    navigator.clipboard.writeText(url);
    copiedId = q.id;
    setTimeout(() => (copiedId = null), 1500);
  }

  // ── Filter helpers ────────────────────────────────────────────────────────────
  const OPERATORS = ['equals','not_equals','contains','not_contains','starts_with','ends_with','gt','lt','gte','lte','is_null','is_not_null','is_true','is_false'];

  function addFilter() { builderFilters = [...builderFilters, { field: '', operator: 'equals', value: '' }]; }
  function removeFilter(i: number) { builderFilters = builderFilters.filter((_, idx) => idx !== i); }
  function addSort() { builderSorts = [...builderSorts, { field: '', direction: 'asc' }]; }
  function removeSort(i: number) { builderSorts = builderSorts.filter((_, idx) => idx !== i); }

  function resultColumns(q: any): string[] {
    const res = results[q.id];
    if (!res?.records?.length) return [];
    return Object.keys(res.records[0]);
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Saved Queries</h1>
      <p class="text-base-content/60 text-sm mt-1">Build, save, and reuse filtered collection queries</p>
    </div>
    <button class="btn btn-primary btn-sm gap-2" onclick={() => (showBuilder = !showBuilder)}>
      <Plus size={16} />
      New Query
    </button>
  </div>

  <!-- Query Builder -->
  {#if showBuilder}
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body space-y-4">
        <h2 class="font-semibold text-lg">Query Builder</h2>

        <!-- Collection + Name -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Collection *</span></label>
            <select class="select select-sm" bind:value={builderCollection} onchange={previewUrl}>
              <option value="">Select collection</option>
              {#each collections as c}<option value={c}>{c}</option>{/each}
            </select>
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Query name *</span></label>
            <input class="input input-sm" type="text" placeholder="e.g. Active orders" bind:value={builderName} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Description</span></label>
            <input class="input input-sm" type="text" placeholder="Optional" bind:value={builderDescription} />
          </div>
        </div>

        <!-- Columns + Limit + Mode -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Columns (comma-separated, empty = all)</span></label>
            <input class="input input-sm" type="text" placeholder="id, name, status" bind:value={builderColumns} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Limit</span></label>
            <input class="input input-sm" type="number" min="1" max="1000" bind:value={builderLimit} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Filter mode</span></label>
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
      <label class="label py-0"><span class="label-text text-xs">Collection</span></label>
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

  <!-- Queries list -->
  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner"></span></div>
  {:else if filtered.length === 0}
    <div class="card bg-base-200 text-center py-16">
      <Bookmark size={40} class="mx-auto mb-3 text-base-content/20" />
      <p class="text-base-content/50">No saved queries yet</p>
      <button class="btn btn-primary btn-sm mt-4" onclick={() => (showBuilder = true)}>Create first query</button>
    </div>
  {:else}
    <div class="space-y-3">
      {#each filtered as q}
        <div class="card bg-base-100 border border-base-300 shadow-sm">
          <div class="card-body p-4 space-y-0">
            <!-- Header row -->
            <div class="flex items-start justify-between gap-2">
              <div class="flex-1 min-w-0">
                {#if editingId === q.id}
                  <div class="flex gap-2 items-center mb-1">
                    <input class="input input-sm flex-1" bind:value={editName} />
                    <button class="btn btn-xs btn-primary" onclick={() => updateQuery(q.id)}>Save</button>
                    <button class="btn btn-xs btn-ghost" onclick={() => (editingId = null)}>Cancel</button>
                  </div>
                  <input class="input input-xs w-full mb-1" placeholder="Description" bind:value={editDescription} />
                  <label class="flex items-center gap-2 text-xs cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-xs" bind:checked={editIsShared} />
                    Share with all users
                  </label>
                {:else}
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-semibold">{q.name}</span>
                    <span class="badge badge-ghost badge-xs">{q.collection}</span>
                    {#if q.is_shared}<span class="badge badge-info badge-xs gap-1"><Share2 size={10} />Shared</span>{/if}
                    {#if q.is_owner}<span class="badge badge-success badge-xs">Mine</span>{/if}
                  </div>
                  {#if q.description}<p class="text-base-content/60 text-xs mt-0.5">{q.description}</p>{/if}
                  <p class="text-base-content/40 text-xs mt-0.5">{new Date(q.created_at).toLocaleDateString()}</p>
                {/if}
              </div>

              <div class="flex gap-1 shrink-0">
                <button class="btn btn-xs btn-ghost" title="Run" onclick={() => runQuery(q)} disabled={runningId === q.id}>
                  {#if runningId === q.id}<span class="loading loading-spinner loading-xs"></span>{:else}<Play size={14} />{/if}
                </button>
                {#if results[q.id]?.api_url}
                  <button class="btn btn-xs btn-ghost" title="Copy API URL" onclick={() => copyUrl(q)}>
                    {#if copiedId === q.id}<Check size={14} class="text-success" />{:else}<Copy size={14} />{/if}
                  </button>
                {/if}
                {#if q.is_owner}
                  <button class="btn btn-xs btn-ghost" title="Edit" onclick={() => startEdit(q)}>
                    <Filter size={14} />
                  </button>
                  <button class="btn btn-xs btn-ghost btn-error" title="Delete" onclick={() => deleteQuery(q.id)}>
                    <Trash2 size={14} />
                  </button>
                {/if}
                <button class="btn btn-xs btn-ghost" onclick={() => (expandedId = expandedId === q.id ? null : q.id)}>
                  {#if expandedId === q.id}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
                </button>
              </div>
            </div>

            <!-- Results panel -->
            {#if expandedId === q.id && results[q.id]}
              {@const res = results[q.id]}
              <div class="mt-3 space-y-2">
                {#if res.api_url}
                  <div class="bg-base-200 rounded px-3 py-1.5 text-xs font-mono text-base-content/60">{res.api_url}</div>
                {/if}
                {#if res.records?.length > 0}
                  <div class="overflow-x-auto max-h-64 border border-base-300 rounded text-xs">
                    <table class="table table-xs">
                      <thead>
                        <tr>{#each resultColumns(q) as col}<th>{col}</th>{/each}</tr>
                      </thead>
                      <tbody>
                        {#each res.records as row}
                          <tr>{#each resultColumns(q) as col}<td>{String(row[col] ?? '')}</td>{/each}</tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                  <p class="text-xs text-base-content/40">
                    Page {res.pagination?.page} · {res.pagination?.total} total rows · {res.pagination?.totalPages} pages
                  </p>
                {:else}
                  <p class="text-xs text-base-content/40 py-2">No records returned</p>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
