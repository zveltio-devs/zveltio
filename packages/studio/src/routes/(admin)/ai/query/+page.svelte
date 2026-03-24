<script lang="ts">
  import { api } from '$lib/api.js';
  import { Search, Save, Clock, Play, Trash2, BarChart2, ChevronDown, ChevronUp } from '@lucide/svelte';

  let prompt = $state('');
  let loading = $state(false);
  let error = $state('');
  let result = $state<any>(null);
  let history = $state<any[]>([]);
  let tab = $state<'query' | 'history'>('query');
  let showSQL = $state(false);
  let saveTitle = $state('');
  let showSaveModal = $state(false);

  async function runQuery() {
    if (!prompt.trim()) return;
    loading = true;
    error = '';
    result = null;
    showSQL = false;
    try {
      result = await api.post('/api/ai/query', { prompt, analyze: true, chart: false, limit: 500 });
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function loadHistory() {
    try {
      const r = await api.get<{ queries: any[] }>('/api/ai/query/history');
      history = r.queries ?? [];
    } catch { /* ignore */ }
  }

  async function saveQuery() {
    if (!result || !saveTitle.trim()) return;
    try {
      await api.patch(`/api/ai/query/${result.id}/save`, { title: saveTitle });
      showSaveModal = false;
      saveTitle = '';
      await loadHistory();
    } catch (e: any) {
      error = e.message;
    }
  }

  async function rerun(id: string) {
    loading = true;
    error = '';
    result = null;
    try {
      result = await api.post(`/api/ai/query/${id}/rerun`, {});
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function deleteQuery(id: string) {
    await api.delete(`/api/ai/query/${id}`);
    history = history.filter(q => q.id !== id);
  }

  $effect(() => {
    if (tab === 'history') loadHistory();
  });

  function onKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runQuery();
  }

  const colCount = $derived(result?.results?.[0] ? Object.keys(result.results[0]).length : 0);
</script>

<div class="p-6 max-w-7xl mx-auto space-y-6">
  <div>
    <h1 class="text-2xl font-bold">AI Query (Text-to-SQL)</h1>
    <p class="text-base-content/60 mt-1">Ask questions in plain language — AI generates and runs the SQL.</p>
  </div>

  <!-- Tabs -->
  <div class="tabs tabs-bordered">
    <button class="tab {tab === 'query' ? 'tab-active' : ''}" onclick={() => tab = 'query'}>Query</button>
    <button class="tab {tab === 'history' ? 'tab-active' : ''}" onclick={() => { tab = 'history'; loadHistory(); }}>History</button>
  </div>

  {#if tab === 'query'}
    <!-- Prompt input -->
    <div class="card bg-base-200 shadow">
      <div class="card-body gap-3">
        <textarea
          class="textarea textarea-bordered w-full min-h-24 text-base"
          placeholder="e.g. Show me the top 10 products by revenue this month..."
          bind:value={prompt}
          onkeydown={onKeydown}
        ></textarea>
        <div class="flex gap-2">
          <button class="btn btn-primary gap-2" onclick={runQuery} disabled={loading || !prompt.trim()}>
            {#if loading}
              <span class="loading loading-spinner loading-sm"></span> Running...
            {:else}
              <Search class="w-4 h-4" /> Run Query
            {/if}
          </button>
          <p class="text-xs text-base-content/40 self-center">Ctrl+Enter to run</p>
        </div>
      </div>
    </div>

    {#if error}
      <div class="alert alert-error">{error}</div>
    {/if}

    {#if result}
      <!-- Metrics bar -->
      <div class="flex flex-wrap gap-4 text-sm text-base-content/60">
        <span><strong>{result.count}</strong> rows</span>
        <span><strong>{result.execution_ms}ms</strong> execution</span>
        <span><strong>{result.total_ms}ms</strong> total</span>
        <button class="link link-primary flex items-center gap-1" onclick={() => showSQL = !showSQL}>
          {#if showSQL}<ChevronUp class="w-3 h-3"/>{:else}<ChevronDown class="w-3 h-3"/>{/if}
          {showSQL ? 'Hide' : 'Show'} SQL
        </button>
        <button class="link link-primary flex items-center gap-1" onclick={() => showSaveModal = true}>
          <Save class="w-3 h-3"/> Save Query
        </button>
      </div>

      {#if showSQL}
        <div class="mockup-code text-sm">
          <pre><code>{result.sql}</code></pre>
        </div>
      {/if}

      {#if result.analysis}
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body">
            <h3 class="font-semibold flex items-center gap-2"><BarChart2 class="w-4 h-4 text-primary"/> AI Analysis</h3>
            <p class="whitespace-pre-wrap text-sm">{result.analysis}</p>
          </div>
        </div>
      {/if}

      <!-- Results table -->
      {#if result.results?.length > 0}
        <div class="overflow-x-auto rounded-lg border border-base-300">
          <table class="table table-sm table-zebra w-full">
            <thead>
              <tr>
                {#each Object.keys(result.results[0]) as col}
                  <th class="whitespace-nowrap">{col}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each result.results as row}
                <tr>
                  {#each Object.values(row) as val}
                    <td class="max-w-xs truncate text-xs font-mono">
                      {#if val === null}<span class="opacity-40">null</span>{:else}{String(val)}{/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="text-center py-8 text-base-content/40">No rows returned.</div>
      {/if}
    {/if}
  {/if}

  {#if tab === 'history'}
    <div class="space-y-2">
      {#each history as q}
        <div class="card bg-base-200 shadow-sm">
          <div class="card-body p-4">
            <div class="flex items-start justify-between gap-2">
              <div class="flex-1 min-w-0">
                {#if q.title}
                  <p class="font-semibold">{q.title}</p>
                {/if}
                <p class="text-sm text-base-content/70 truncate">{q.prompt}</p>
                <div class="flex gap-3 mt-1 text-xs text-base-content/40">
                  <span>{new Date(q.created_at).toLocaleString()}</span>
                  {#if q.result_count !== null}
                    <span>{q.result_count} rows · {q.execution_ms}ms</span>
                  {/if}
                  {#if q.is_saved}
                    <span class="badge badge-xs badge-primary">Saved</span>
                  {/if}
                  {#if q.error}
                    <span class="text-error">{q.error}</span>
                  {/if}
                </div>
              </div>
              <div class="flex gap-2 shrink-0">
                {#if q.generated_sql}
                  <button class="btn btn-xs btn-ghost gap-1" onclick={() => rerun(q.id)}>
                    <Play class="w-3 h-3"/> Rerun
                  </button>
                {/if}
                <button class="btn btn-xs btn-ghost text-error" onclick={() => deleteQuery(q.id)}>
                  <Trash2 class="w-3 h-3"/>
                </button>
              </div>
            </div>
          </div>
        </div>
      {:else}
        <div class="text-center py-12 text-base-content/40">
          <Clock class="w-8 h-8 mx-auto mb-2"/>
          No query history yet. Run a query to get started.
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Save modal -->
{#if showSaveModal}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg">Save Query</h3>
      <div class="form-control mt-4">
        <label class="label" for="save-query-title"><span class="label-text">Title</span></label>
        <input id="save-query-title" class="input input-bordered" bind:value={saveTitle} placeholder="My saved query..." />
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => showSaveModal = false}>Cancel</button>
        <button class="btn btn-primary" onclick={saveQuery} disabled={!saveTitle.trim()}>Save</button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => showSaveModal = false}></button>
  </dialog>
{/if}
