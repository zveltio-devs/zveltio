<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import Plus from '@lucide/svelte/icons/plus.svelte';
  import Trash2 from '@lucide/svelte/icons/trash-2.svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw.svelte';

  interface Constraint {
    name: string;
    type: 'CHECK' | 'UNIQUE' | 'NOT NULL' | 'FOREIGN KEY';
    definition: string;
    columns?: string[];
  }

  let { collection, columns = [] }: { collection: string; columns: string[] } = $props();

  let constraints = $state<Constraint[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let showForm = $state(false);
  let saving = $state(false);

  let newConstraint = $state<{ type: string; columns: string[]; definition: string }>({
    type: 'CHECK',
    columns: [],
    definition: '',
  });

  onMount(load);

  async function load() {
    loading = true;
    error = null;
    try {
      const data = await api.get<{ constraints: Constraint[] }>(`/api/collections/${collection}/constraints`);
      constraints = data.constraints || [];
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load constraints';
    } finally {
      loading = false;
    }
  }

  async function createConstraint() {
    if (!newConstraint.definition.trim()) return;
    saving = true;
    error = null;
    try {
      await api.post(`/api/collections/${collection}/constraints`, newConstraint);
      newConstraint = { type: 'CHECK', columns: [], definition: '' };
      showForm = false;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create constraint';
    } finally {
      saving = false;
    }
  }

  async function dropConstraint(name: string) {
    if (!confirm(`Drop constraint "${name}"?`)) return;
    try {
      await api.delete(`/api/collections/${collection}/constraints/${name}`);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to drop constraint';
    }
  }

  function toggleColumn(col: string) {
    if (newConstraint.columns.includes(col)) {
      newConstraint.columns = newConstraint.columns.filter((c) => c !== col);
    } else {
      newConstraint.columns = [...newConstraint.columns, col];
    }
  }

  const typeBadge: Record<string, string> = {
    CHECK: 'badge-warning',
    UNIQUE: 'badge-primary',
    'NOT NULL': 'badge-info',
    'FOREIGN KEY': 'badge-secondary',
  };
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between">
    <h3 class="font-semibold text-sm">Constraints ({constraints.length})</h3>
    <div class="flex gap-1">
      <button class="btn btn-xs btn-ghost" onclick={load} title="Refresh"><RefreshCw size={12} /></button>
      <button class="btn btn-xs btn-primary gap-1" onclick={() => (showForm = !showForm)}>
        <Plus size={12} /> Add Constraint
      </button>
    </div>
  </div>

  {#if error}
    <div class="alert alert-error text-xs py-2">{error}</div>
  {/if}

  {#if showForm}
    <div class="border border-base-300 rounded-lg p-3 bg-base-200 space-y-3">
      <p class="text-xs font-semibold">New Constraint</p>

      <div class="form-control">
        <label class="label py-0"><span class="label-text text-xs">Type</span></label>
        <select class="select select-bordered select-xs" bind:value={newConstraint.type}>
          <option value="CHECK">CHECK</option>
          <option value="UNIQUE">UNIQUE</option>
          <option value="NOT NULL">NOT NULL</option>
        </select>
      </div>

      {#if newConstraint.type === 'UNIQUE' || newConstraint.type === 'NOT NULL'}
        <div>
          <p class="text-xs opacity-60 mb-1">Columns:</p>
          <div class="flex flex-wrap gap-1">
            {#each columns as col}
              <button
                type="button"
                class="badge badge-sm cursor-pointer"
                class:badge-primary={newConstraint.columns.includes(col)}
                class:badge-ghost={!newConstraint.columns.includes(col)}
                onclick={() => toggleColumn(col)}
              >{col}</button>
            {/each}
          </div>
        </div>
      {/if}

      {#if newConstraint.type === 'CHECK'}
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">Expression (SQL)</span></label>
          <input
            type="text"
            class="input input-bordered input-xs font-mono"
            placeholder="e.g., price > 0"
            bind:value={newConstraint.definition}
          />
        </div>
      {:else}
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">Constraint Name (optional)</span></label>
          <input
            type="text"
            class="input input-bordered input-xs font-mono"
            placeholder="auto-generated if empty"
            bind:value={newConstraint.definition}
          />
        </div>
      {/if}

      <div class="flex gap-2">
        <button class="btn btn-xs btn-primary" onclick={createConstraint}
          disabled={saving || (!newConstraint.definition.trim() && newConstraint.columns.length === 0)}>
          {saving ? 'Creating...' : 'Create'}
        </button>
        <button class="btn btn-xs btn-ghost" onclick={() => (showForm = false)}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-4"><span class="loading loading-spinner loading-sm"></span></div>
  {:else if constraints.length === 0}
    <p class="text-xs opacity-40 text-center py-4">No custom constraints defined.</p>
  {:else}
    <div class="space-y-1">
      {#each constraints as c}
        <div class="flex items-center justify-between border border-base-300 rounded px-3 py-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="badge badge-xs {typeBadge[c.type] || 'badge-ghost'}">{c.type}</span>
            <span class="font-mono text-xs truncate">{c.name}</span>
            {#if c.definition}
              <span class="text-xs opacity-50 truncate">{c.definition}</span>
            {/if}
          </div>
          <button class="btn btn-ghost btn-xs text-error shrink-0" onclick={() => dropConstraint(c.name)}>
            <Trash2 size={12} />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>
