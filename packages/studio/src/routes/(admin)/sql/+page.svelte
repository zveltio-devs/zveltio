<script lang="ts">
  import { api } from '$lib/api.js';
  import { Terminal } from '@lucide/svelte';

  let query = $state('SELECT * FROM "user" LIMIT 10;');
  let rows: Record<string, any>[] = $state([]);
  let columns: string[] = $state([]);
  let rowCount = $state<number | null>(null);
  let error = $state('');
  let running = $state(false);
  let elapsed = $state<number | null>(null);

  async function runQuery() {
    if (!query.trim()) return;
    running = true;
    error = '';
    rows = [];
    columns = [];
    rowCount = null;
    elapsed = null;
    const start = Date.now();
    try {
      const body = await api.post<{ rows: Record<string, any>[]; rowCount: number }>('/api/admin/sql', { query });
      elapsed = Date.now() - start;
      rows = body.rows ?? [];
      rowCount = body.rowCount ?? rows.length;
      columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    } catch (e: any) {
      elapsed = Date.now() - start;
      error = e.message ?? String(e);
    } finally {
      running = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runQuery();
    }
  }
</script>

<div class="p-6 max-w-full">
  <div class="flex items-center gap-3 mb-6">
    <Terminal class="w-6 h-6 text-primary" />
    <div>
      <h1 class="text-2xl font-bold">SQL Editor</h1>
      <p class="text-base-content/60 text-sm">Run SQL queries directly against the database. Admin only.</p>
    </div>
  </div>

  <div class="card bg-base-200 border border-base-300 mb-4">
    <div class="card-body p-4">
      <textarea
        class="textarea textarea-bordered font-mono text-sm w-full min-h-40 bg-base-100 resize-y"
        placeholder="SELECT * FROM zvd_products LIMIT 10;"
        bind:value={query}
        onkeydown={handleKeydown}
        spellcheck={false}
      ></textarea>
      <div class="flex items-center justify-between mt-2">
        <span class="text-xs text-base-content/40">Ctrl+Enter to run</span>
        <button class="btn btn-primary btn-sm gap-2" onclick={runQuery} disabled={running}>
          {#if running}
            <span class="loading loading-spinner loading-xs"></span>
          {/if}
          Run Query
        </button>
      </div>
    </div>
  </div>

  {#if error}
    <div class="alert alert-error mb-4">
      <span class="font-mono text-sm">{error}</span>
    </div>
  {/if}

  {#if rowCount !== null}
    <div class="flex items-center gap-4 mb-3 text-sm text-base-content/60">
      <span>{rowCount} row{rowCount !== 1 ? 's' : ''}</span>
      {#if elapsed !== null}<span>{elapsed}ms</span>{/if}
    </div>

    {#if rows.length > 0}
      <div class="overflow-x-auto rounded-xl border border-base-300">
        <table class="table table-sm table-zebra w-full">
          <thead>
            <tr>
              {#each columns as col}
                <th class="font-mono text-xs">{col}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows as row}
              <tr>
                {#each columns as col}
                  <td class="font-mono text-xs max-w-xs truncate" title={String(row[col] ?? '')}>
                    {#if row[col] === null}
                      <span class="text-base-content/30 italic">null</span>
                    {:else if typeof row[col] === 'object'}
                      <span class="text-info">{JSON.stringify(row[col])}</span>
                    {:else}
                      {String(row[col])}
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="text-center py-8 text-base-content/40 text-sm">Query executed — no rows returned.</div>
    {/if}
  {/if}
</div>
