<script lang="ts">
  import { onMount } from 'svelte';
  import { BarChart2, Plus, Trash2, Play, Grid, Code2, X, GripVertical, RefreshCw } from '@lucide/svelte';

  const engineUrl = (import.meta as any).env?.PUBLIC_ENGINE_URL ?? '';

  // ── Types ─────────────────────────────────────────────────────────────────────
  interface Panel {
    id: string;
    name: string;
    type: string;
    query: string;
    config: any;
    position_x: number;
    position_y: number;
    width: number;
    height: number;
  }

  interface Dashboard {
    id: string;
    name: string;
    description?: string;
    icon: string;
    is_default: boolean;
    panel_count: number;
    created_at: string;
  }

  // ── State ─────────────────────────────────────────────────────────────────────
  let dashboards = $state<Dashboard[]>([]);
  let activeDashboard = $state<Dashboard | null>(null);
  let panels = $state<Panel[]>([]);
  let panelResults = $state<Record<string, { data: any[]; error?: string; loading?: boolean }>>({});

  let loadingDashboards = $state(true);
  let loadingPanels = $state(false);

  // New dashboard
  let showNewDash = $state(false);
  let newDashName = $state('');
  let newDashDescription = $state('');
  let newDashIcon = $state('BarChart');

  // New panel
  let showNewPanel = $state(false);
  let newPanelName = $state('');
  let newPanelType = $state('table');
  let newPanelQuery = $state('');
  let newPanelWidth = $state(6);
  let newPanelHeight = $state(4);

  // Ad-hoc query
  let showAdHoc = $state(false);
  let adHocQuery = $state('SELECT');
  let adHocResult = $state<any>(null);
  let adHocError = $state('');
  let adHocRunning = $state(false);

  const PANEL_TYPES = ['table', 'bar', 'line', 'pie', 'stat', 'text'];
  const DASH_ICONS = ['BarChart', 'LineChart', 'PieChart', 'Activity', 'Database', 'Globe', 'Users', 'ShoppingCart'];

  onMount(loadDashboards);

  async function loadDashboards() {
    loadingDashboards = true;
    const res = await fetch(`${engineUrl}/api/insights/dashboards`, { credentials: 'include' }).then(r => r.json());
    dashboards = res.dashboards ?? [];
    if (dashboards.length > 0 && !activeDashboard) {
      await selectDashboard(dashboards[0]);
    }
    loadingDashboards = false;
  }

  async function selectDashboard(d: Dashboard) {
    activeDashboard = d;
    loadingPanels = true;
    panelResults = {};
    const res = await fetch(`${engineUrl}/api/insights/dashboards/${d.id}`, { credentials: 'include' }).then(r => r.json());
    panels = res.panels ?? [];
    loadingPanels = false;
    // Auto-run all panels
    panels.forEach(p => runPanel(p));
  }

  async function createDashboard() {
    if (!newDashName) return;
    const res = await fetch(`${engineUrl}/api/insights/dashboards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: newDashName, description: newDashDescription, icon: newDashIcon }),
    }).then(r => r.json());
    showNewDash = false;
    newDashName = '';
    newDashDescription = '';
    await loadDashboards();
  }

  async function deleteDashboard(id: string) {
    if (!confirm('Delete this dashboard and all its panels?')) return;
    await fetch(`${engineUrl}/api/insights/dashboards/${id}`, { method: 'DELETE', credentials: 'include' });
    if (activeDashboard?.id === id) {
      activeDashboard = null;
      panels = [];
    }
    await loadDashboards();
  }

  async function addPanel() {
    if (!activeDashboard || !newPanelName || !newPanelQuery) return;
    await fetch(`${engineUrl}/api/insights/dashboards/${activeDashboard.id}/panels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        name: newPanelName,
        type: newPanelType,
        query: newPanelQuery,
        width: newPanelWidth,
        height: newPanelHeight,
      }),
    });
    showNewPanel = false;
    newPanelName = '';
    newPanelQuery = 'SELECT';
    await selectDashboard(activeDashboard);
  }

  async function deletePanel(id: string) {
    await fetch(`${engineUrl}/api/insights/panels/${id}`, { method: 'DELETE', credentials: 'include' });
    panels = panels.filter(p => p.id !== id);
    const r = { ...panelResults };
    delete r[id];
    panelResults = r;
  }

  async function runPanel(p: Panel) {
    panelResults = { ...panelResults, [p.id]: { data: [], loading: true } };
    const res = await fetch(`${engineUrl}/api/insights/panels/${p.id}/execute`, {
      method: 'POST',
      credentials: 'include',
    }).then(r => r.json());
    panelResults = {
      ...panelResults,
      [p.id]: {
        data: res.data ?? [],
        error: res.error,
        loading: false,
      },
    };
  }

  async function runAdHoc() {
    adHocRunning = true;
    adHocError = '';
    adHocResult = null;
    const res = await fetch(`${engineUrl}/api/insights/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query: adHocQuery }),
    }).then(r => r.json());
    if (res.error) adHocError = res.error;
    else adHocResult = res;
    adHocRunning = false;
  }

  function panelColumns(p: Panel): string[] {
    const res = panelResults[p.id];
    if (!res?.data?.length) return [];
    return Object.keys(res.data[0]);
  }

  function statValue(p: Panel): string {
    const res = panelResults[p.id];
    if (!res?.data?.length) return '—';
    const first = res.data[0];
    const val = Object.values(first)[0];
    return String(val ?? '—');
  }
</script>

<div class="flex h-[calc(100vh-8rem)] gap-0 -mx-4 -mt-4">
  <!-- Sidebar: dashboard list -->
  <div class="w-56 border-r border-base-300 bg-base-200 flex flex-col shrink-0">
    <div class="p-3 border-b border-base-300 flex items-center justify-between">
      <span class="font-semibold text-sm">Dashboards</span>
      <button class="btn btn-xs btn-ghost" onclick={() => (showNewDash = true)} title="New dashboard">
        <Plus size={14} />
      </button>
    </div>

    {#if loadingDashboards}
      <div class="flex justify-center p-4"><span class="loading loading-spinner loading-sm"></span></div>
    {:else if dashboards.length === 0}
      <div class="p-4 text-center text-xs text-base-content/40">No dashboards</div>
    {:else}
      <div class="flex-1 overflow-y-auto">
        {#each dashboards as d}
          <button
            class="w-full text-left px-3 py-2.5 text-sm hover:bg-base-300 transition-colors flex items-center justify-between group
              {activeDashboard?.id === d.id ? 'bg-primary/10 text-primary font-medium' : ''}"
            onclick={() => selectDashboard(d)}
          >
            <span class="truncate">{d.name}</span>
            <span class="badge badge-ghost badge-xs opacity-60 shrink-0 ml-1">{d.panel_count}</span>
          </button>
        {/each}
      </div>
    {/if}

    <!-- Ad-hoc query button -->
    <div class="p-3 border-t border-base-300">
      <button class="btn btn-xs btn-outline w-full gap-1" onclick={() => (showAdHoc = !showAdHoc)}>
        <Code2 size={12} /> SQL Console
      </button>
    </div>
  </div>

  <!-- Main content -->
  <div class="flex-1 flex flex-col overflow-hidden">
    {#if activeDashboard}
      <!-- Dashboard header -->
      <div class="px-5 py-3 border-b border-base-300 flex items-center justify-between gap-3 shrink-0">
        <div>
          <h1 class="text-xl font-bold">{activeDashboard.name}</h1>
          {#if activeDashboard.description}
            <p class="text-xs text-base-content/50">{activeDashboard.description}</p>
          {/if}
        </div>
        <div class="flex gap-2">
          <button class="btn btn-sm btn-ghost gap-1" onclick={() => selectDashboard(activeDashboard!)} title="Refresh all">
            <RefreshCw size={14} />
          </button>
          <button class="btn btn-sm btn-primary gap-1" onclick={() => (showNewPanel = true)}>
            <Plus size={14} /> Add panel
          </button>
          <button class="btn btn-sm btn-ghost btn-error" onclick={() => deleteDashboard(activeDashboard!.id)}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <!-- Panels grid -->
      <div class="flex-1 overflow-y-auto p-5">
        {#if loadingPanels}
          <div class="flex justify-center py-12"><span class="loading loading-spinner"></span></div>
        {:else if panels.length === 0}
          <div class="flex flex-col items-center justify-center h-64 text-center">
            <Grid size={40} class="text-base-content/20 mb-3" />
            <p class="text-base-content/50 mb-3">No panels yet</p>
            <button class="btn btn-primary btn-sm" onclick={() => (showNewPanel = true)}>Add first panel</button>
          </div>
        {:else}
          <div class="grid grid-cols-12 gap-4">
            {#each panels as p}
              {@const res = panelResults[p.id]}
              <div class="col-span-{Math.min(p.width, 12)} card bg-base-100 border border-base-300 shadow-sm">
                <div class="card-body p-4 space-y-2">
                  <!-- Panel header -->
                  <div class="flex items-center justify-between">
                    <span class="font-medium text-sm">{p.name}</span>
                    <div class="flex gap-1">
                      <span class="badge badge-ghost badge-xs">{p.type}</span>
                      <button class="btn btn-xs btn-ghost" onclick={() => runPanel(p)} title="Refresh">
                        {#if res?.loading}<span class="loading loading-spinner loading-xs"></span>{:else}<RefreshCw size={12} />{/if}
                      </button>
                      <button class="btn btn-xs btn-ghost btn-error" onclick={() => deletePanel(p.id)}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  <!-- Panel content -->
                  {#if res?.error}
                    <div class="alert alert-error py-2 text-xs">{res.error}</div>
                  {:else if res?.loading}
                    <div class="flex justify-center py-4"><span class="loading loading-spinner loading-sm"></span></div>
                  {:else if p.type === 'stat'}
                    <div class="flex flex-col items-center justify-center py-4">
                      <span class="text-4xl font-bold text-primary">{statValue(p)}</span>
                      <span class="text-xs text-base-content/40 mt-1">{panelColumns(p)[0] ?? ''}</span>
                    </div>
                  {:else if p.type === 'text'}
                    <div class="prose prose-sm max-w-none">
                      <pre class="text-xs whitespace-pre-wrap">{JSON.stringify(res?.data ?? [], null, 2)}</pre>
                    </div>
                  {:else}
                    <!-- Table view (bar/line/pie fallback to table until charting lib is added) -->
                    {#if res?.data?.length}
                      <div class="overflow-x-auto max-h-48 text-xs">
                        <table class="table table-xs">
                          <thead>
                            <tr>{#each panelColumns(p) as col}<th>{col}</th>{/each}</tr>
                          </thead>
                          <tbody>
                            {#each res.data as row}
                              <tr>{#each panelColumns(p) as col}<td>{String(row[col] ?? '')}</td>{/each}</tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                      <p class="text-xs text-base-content/30">{res.data.length} rows</p>
                    {:else}
                      <p class="text-xs text-base-content/40 py-3 text-center">No data</p>
                    {/if}
                  {/if}

                  <!-- Query (collapsed) -->
                  <details class="text-xs">
                    <summary class="cursor-pointer text-base-content/30 hover:text-base-content/60">SQL</summary>
                    <pre class="bg-base-200 rounded p-2 mt-1 overflow-x-auto font-mono">{p.query}</pre>
                  </details>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {:else if !loadingDashboards}
      <!-- Empty state -->
      <div class="flex-1 flex flex-col items-center justify-center text-center gap-4">
        <BarChart2 size={48} class="text-base-content/20" />
        <div>
          <p class="font-semibold">No dashboard selected</p>
          <p class="text-sm text-base-content/50">Create a dashboard to get started</p>
        </div>
        <button class="btn btn-primary btn-sm" onclick={() => (showNewDash = true)}>Create dashboard</button>
      </div>
    {/if}
  </div>
</div>

<!-- Modal: New Dashboard -->
{#if showNewDash}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-sm">
      <h3 class="font-bold text-lg mb-4">New Dashboard</h3>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">Name *</span></label>
          <input class="input input-sm" type="text" placeholder="e.g. Sales Overview" bind:value={newDashName} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">Description</span></label>
          <input class="input input-sm" type="text" placeholder="Optional" bind:value={newDashDescription} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">Icon</span></label>
          <select class="select select-sm" bind:value={newDashIcon}>
            {#each DASH_ICONS as icon}<option value={icon}>{icon}</option>{/each}
          </select>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showNewDash = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" onclick={createDashboard} disabled={!newDashName}>Create</button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showNewDash = false)}></button>
  </dialog>
{/if}

<!-- Modal: New Panel -->
{#if showNewPanel}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-lg">
      <h3 class="font-bold text-lg mb-4">Add Panel</h3>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Name *</span></label>
            <input class="input input-sm" type="text" placeholder="e.g. Orders by month" bind:value={newPanelName} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Type</span></label>
            <select class="select select-sm" bind:value={newPanelType}>
              {#each PANEL_TYPES as t}<option value={t}>{t}</option>{/each}
            </select>
          </div>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">SQL Query * (SELECT only)</span></label>
          <textarea class="textarea textarea-sm font-mono text-xs" rows="5" placeholder="SELECT COUNT(*) as total FROM zvd_orders" bind:value={newPanelQuery}></textarea>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Width (cols/12)</span></label>
            <input class="input input-sm" type="number" min="1" max="12" bind:value={newPanelWidth} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Height (rows)</span></label>
            <input class="input input-sm" type="number" min="1" max="20" bind:value={newPanelHeight} />
          </div>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showNewPanel = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" onclick={addPanel} disabled={!newPanelName || !newPanelQuery}>Add Panel</button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showNewPanel = false)}></button>
  </dialog>
{/if}

<!-- Ad-hoc SQL Console (slide-up) -->
{#if showAdHoc}
  <div class="fixed bottom-0 left-0 right-0 bg-base-100 border-t border-base-300 shadow-2xl z-40 p-4 space-y-3">
    <div class="flex items-center justify-between">
      <span class="font-semibold text-sm flex items-center gap-2"><Code2 size={16} /> SQL Console (admin)</span>
      <button class="btn btn-xs btn-ghost" onclick={() => (showAdHoc = false)}><X size={14} /></button>
    </div>
    <div class="flex gap-2">
      <textarea
        class="textarea textarea-sm font-mono text-xs flex-1"
        rows="3"
        placeholder="SELECT COUNT(*) FROM zvd_orders WHERE status = 'active'"
        bind:value={adHocQuery}
      ></textarea>
      <button class="btn btn-primary btn-sm self-end gap-1" onclick={runAdHoc} disabled={adHocRunning}>
        {#if adHocRunning}<span class="loading loading-spinner loading-xs"></span>{:else}<Play size={14} />{/if}
        Run
      </button>
    </div>
    {#if adHocError}
      <div class="alert alert-error py-2 text-xs">{adHocError}</div>
    {/if}
    {#if adHocResult}
      <div class="overflow-x-auto max-h-40 border border-base-300 rounded text-xs">
        <table class="table table-xs">
          <thead>
            <tr>{#each (adHocResult.columns ?? []) as col}<th>{col}</th>{/each}</tr>
          </thead>
          <tbody>
            {#each adHocResult.data as row}
              <tr>{#each (adHocResult.columns ?? []) as col}<td>{String(row[col] ?? '')}</td>{/each}</tr>
            {/each}
          </tbody>
        </table>
        <p class="p-2 text-base-content/40">{adHocResult.data?.length} rows</p>
      </div>
    {/if}
  </div>
{/if}
