<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Database, Table2, Search, LoaderCircle } from '@lucide/svelte';

  let tables = $state<any[]>([]);
  let q = $state('');
  let activeTable = $state<any | null>(null);
  let columns = $state<any[]>([]);
  let rows = $state<any[]>([]);
  let rowCount = $state(0);
  let loading = $state(true);

  async function loadTables() {
    loading = true;
    try {
      const r = await api.get<{ data?: any[]; tables?: any[] }>('/api/database/tables');
      tables = (r.data ?? r.tables ?? []).filter((t: any) => !t.name?.startsWith('zv_') || t.is_data);
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function openTable(t: any) {
    activeTable = t;
    try {
      const r = await api.get<any>(`/api/database/tables/${encodeURIComponent(t.name)}`);
      columns = r.columns ?? r.data?.columns ?? [];
      rows = r.rows ?? r.data?.rows ?? [];
      rowCount = r.row_count ?? r.data?.row_count ?? rows.length;
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  let filteredTables = $derived(
    q ? tables.filter((t) => (t.name as string).toLowerCase().includes(q.toLowerCase())) : tables,
  );

  onMount(loadTables);
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-xl font-semibold flex items-center gap-2"><Database size={20} /> Database</h1>
    <p class="text-sm text-base-content/50">Inspect tables, schemas, and sample rows</p>
  </div>

  <div class="grid grid-cols-12 gap-4">
    <aside class="col-span-3">
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-0">
          <div class="p-3 border-b border-base-300">
            <div class="font-medium text-sm mb-2">Tables ({tables.length})</div>
            <div class="join w-full">
              <input class="input input-xs join-item flex-1" placeholder="Filter…" bind:value={q} />
              <button class="btn btn-xs join-item" onclick={loadTables}><Search size={12} /></button>
            </div>
          </div>
          <ul class="menu menu-sm p-2 max-h-[60vh] overflow-y-auto">
            {#if loading}
              <li class="p-3 text-base-content/60 text-sm">Loading…</li>
            {:else if filteredTables.length === 0}
              <li class="p-3 text-base-content/60 text-sm">No tables.</li>
            {:else}
              {#each filteredTables as t (t.name)}
                <li>
                  <button class="font-mono text-xs gap-1 {activeTable?.name === t.name ? 'active' : ''}" onclick={() => openTable(t)}>
                    <Table2 size={13} class="shrink-0" /> {t.name}
                  </button>
                </li>
              {/each}
            {/if}
          </ul>
        </div>
      </div>
    </aside>

    <main class="col-span-9">
      {#if !activeTable}
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body items-center py-16">
            <p class="text-base-content/50 text-sm">Select a table to inspect.</p>
          </div>
        </div>
      {:else}
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-0">
            <div class="p-3 border-b border-base-300">
              <div class="font-mono font-medium text-sm">{activeTable.name}</div>
              <div class="text-xs text-base-content/60">{rowCount.toLocaleString()} rows · {columns.length} columns</div>
            </div>

            <div class="p-3 border-b border-base-300">
              <div class="font-medium text-xs mb-2 text-base-content/70 uppercase tracking-wider">Schema</div>
              <div class="overflow-x-auto">
                <table class="table table-xs">
                  <thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Default</th></tr></thead>
                  <tbody>
                    {#each columns as c (c.name)}
                      <tr><td class="font-mono">{c.name}</td><td><span class="badge badge-ghost badge-xs">{c.type ?? c.data_type}</span></td><td class="text-xs">{(c.nullable ?? c.is_nullable) ? 'yes' : 'no'}</td><td class="font-mono text-xs text-base-content/60">{c.default ?? '—'}</td></tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>

            <div class="p-3">
              <div class="font-medium text-xs mb-2 text-base-content/70 uppercase tracking-wider">Sample rows</div>
              <div class="overflow-x-auto">
                <table class="table table-xs">
                  <thead><tr>{#each columns.slice(0, 8) as c (c.name)}<th class="font-mono">{c.name}</th>{/each}</tr></thead>
                  <tbody>
                    {#if rows.length === 0}
                      <tr><td colspan={Math.max(1, columns.slice(0, 8).length)} class="text-center py-6 text-base-content/50 text-sm">No rows.</td></tr>
                    {:else}
                      {#each rows.slice(0, 50) as row, idx (idx)}
                        <tr>
                          {#each columns.slice(0, 8) as c (c.name)}
                            <td class="max-w-xs truncate text-xs">{row[c.name] === null ? '—' : typeof row[c.name] === 'object' ? JSON.stringify(row[c.name]) : String(row[c.name])}</td>
                          {/each}
                        </tr>
                      {/each}
                    {/if}
                  </tbody>
                </table>
              </div>
              {#if rows.length > 50}<div class="text-xs text-base-content/50 mt-2">Showing first 50 of {rowCount}.</div>{/if}
            </div>
          </div>
        </div>
      {/if}
    </main>
  </div>
</div>
