<script lang="ts">
 import { onMount } from 'svelte';
 import { api } from '$lib/api.js';
 import Plus from '@lucide/svelte/icons/plus.svelte';
 import Trash2 from '@lucide/svelte/icons/trash-2.svelte';
 import RefreshCw from '@lucide/svelte/icons/refresh-cw.svelte';

 interface Index {
 name: string;
 columns: string[];
 unique: boolean;
 type?: string;
 }

 let { collection, columns = [] }: { collection: string; columns: string[] } = $props();

 let indexes = $state<Index[]>([]);
 let loading = $state(true);
 let error = $state<string | null>(null);
 let showForm = $state(false);
 let saving = $state(false);

 let newIndex = $state<{ columns: string[]; unique: boolean }>({ columns: [], unique: false });

 onMount(load);

 async function load() {
 loading = true;
 error = null;
 try {
 const data = await api.get<{ indexes: Index[] }>(`/api/collections/${collection}/indexes`);
 indexes = data.indexes || [];
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to load indexes';
 } finally {
 loading = false;
 }
 }

 async function createIndex() {
 if (newIndex.columns.length === 0) return;
 saving = true;
 error = null;
 try {
 await api.post(`/api/collections/${collection}/indexes`, newIndex);
 newIndex = { columns: [], unique: false };
 showForm = false;
 await load();
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to create index';
 } finally {
 saving = false;
 }
 }

 async function dropIndex(name: string) {
 if (!confirm(`Drop index "${name}"?`)) return;
 try {
 await api.delete(`/api/collections/${collection}/indexes/${name}`);
 await load();
 } catch (e) {
 error = e instanceof Error ? e.message : 'Failed to drop index';
 }
 }

 function toggleColumn(col: string) {
 if (newIndex.columns.includes(col)) {
 newIndex.columns = newIndex.columns.filter((c) => c !== col);
 } else {
 newIndex.columns = [...newIndex.columns, col];
 }
 }
</script>

<div class="space-y-3">
 <div class="flex items-center justify-between">
 <h3 class="font-semibold text-sm">Indexes ({indexes.length})</h3>
 <div class="flex gap-1">
 <button class="btn btn-xs btn-ghost" onclick={load} title="Refresh"><RefreshCw size={12} /></button>
 <button class="btn btn-xs btn-primary gap-1" onclick={() => (showForm = !showForm)}>
 <Plus size={12} /> Add Index
 </button>
 </div>
 </div>

 {#if error}
 <div class="alert alert-error text-xs py-2">{error}</div>
 {/if}

 {#if showForm}
 <div class="border border-base-300 rounded-lg p-3 bg-base-200 space-y-3">
 <p class="text-xs font-semibold">New Index</p>

 <div>
 <p class="text-xs opacity-60 mb-1">Columns (select one or more):</p>
 <div class="flex flex-wrap gap-1">
 {#each columns as col}
 <button
 type="button"
 class="badge badge-sm cursor-pointer"
 class:badge-primary={newIndex.columns.includes(col)}
 class:badge-ghost={!newIndex.columns.includes(col)}
 onclick={() => toggleColumn(col)}
 >{col}</button>
 {/each}
 {#if columns.length === 0}
 <span class="text-xs opacity-40">No columns available</span>
 {/if}
 </div>
 </div>

 <label class="flex items-center gap-2 cursor-pointer">
 <input type="checkbox" class="checkbox checkbox-xs" bind:checked={newIndex.unique} />
 <span class="text-xs">Unique index</span>
 </label>

 <div class="flex gap-2">
 <button class="btn btn-xs btn-primary" onclick={createIndex}
 disabled={saving || newIndex.columns.length === 0}>
 {saving ? 'Creating...' : 'Create'}
 </button>
 <button class="btn btn-xs btn-ghost" onclick={() => (showForm = false)}>Cancel</button>
 </div>
 </div>
 {/if}

 {#if loading}
 <div class="flex justify-center py-4"><span class="loading loading-spinner loading-sm"></span></div>
 {:else if indexes.length === 0}
 <p class="text-xs opacity-40 text-center py-4">No custom indexes. Primary key index is managed automatically.</p>
 {:else}
 <div class="overflow-x-auto">
 <table class="table table-xs">
 <thead>
 <tr>
 <th>Name</th>
 <th>Columns</th>
 <th>Type</th>
 <th></th>
 </tr>
 </thead>
 <tbody>
 {#each indexes as idx}
 <tr>
 <td class="font-mono text-xs">{idx.name}</td>
 <td class="text-xs">{idx.columns.join(', ')}</td>
 <td>
 {#if idx.unique}
 <span class="badge badge-xs badge-primary">UNIQUE</span>
 {:else}
 <span class="badge badge-xs badge-ghost">INDEX</span>
 {/if}
 </td>
 <td>
 <button class="btn btn-ghost btn-xs text-error" onclick={() => dropIndex(idx.name)}>
 <Trash2 size={12} />
 </button>
 </td>
 </tr>
 {/each}
 </tbody>
 </table>
 </div>
 {/if}
</div>
