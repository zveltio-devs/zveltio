<script lang="ts">
 import { onMount } from 'svelte';
 import { api, collectionsApi } from '$lib/api.js';
 import { Download, LoaderCircle, Database } from '@lucide/svelte';
 import PageHeader from '$lib/components/common/PageHeader.svelte';

 let collections = $state<any[]>([]);
 let selectedCollection = $state('');
 let format = $state<'json' | 'csv' | 'ndjson'>('json');
 let limit = $state(1000);
 let exporting = $state(false);
 let error = $state('');

 onMount(async () => {
 const res = await collectionsApi.list();
 collections = res.collections || [];
 });

 async function doExport() {
 if (!selectedCollection) return;
 exporting = true;
 error = '';
 try {
 const params = new URLSearchParams({
 format,
 limit: String(limit),
 });
 const res = await fetch(`/api/export/${selectedCollection}?${params}`, {
 credentials: 'include',
 });
 if (!res.ok) {
 const body = await res.json().catch(() => ({}));
 throw new Error(body.error || `Export failed (${res.status})`);
 }

 const blob = await res.blob();
 const ext = format === 'ndjson' ? 'ndjson' : format;
 const fileName = `${selectedCollection}_${new Date().toISOString().split('T')[0]}.${ext}`;
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = fileName;
 a.click();
 URL.revokeObjectURL(url);
 } catch (err) {
 error = err instanceof Error ? err.message : 'Export failed';
 } finally {
 exporting = false;
 }
 }
</script>

<div class="space-y-6">
 <PageHeader title="Export Data" subtitle="Download collection data in various formats" />

 <div class="max-w-lg">
 <div class="card bg-base-200">
 <div class="card-body space-y-5">
 <div class="form-control">
 <label class="label" for="export-collection"><span class="label-text font-medium">Collection *</span></label>
 <select id="export-collection" class="select" bind:value={selectedCollection}>
 <option value="">— Select collection —</option>
 {#each collections as col}
 <option value={col.name}>{col.display_name || col.name}</option>
 {/each}
 </select>
 </div>

 <div class="form-control">
 <p class="label"><span class="label-text font-medium">Format</span></p>
 <div class="flex gap-3">
 {#each [['json', 'JSON'], ['csv', 'CSV'], ['ndjson', 'NDJSON']] as [val, label]}
 <label class="flex items-center gap-2 cursor-pointer">
 <input type="radio" class="radio radio-sm radio-primary" name="format"
 value={val} bind:group={format} />
 <span class="text-sm">{label}</span>
 </label>
 {/each}
 </div>
 <p class="text-xs text-base-content/50 mt-1">
 {format === 'json' ? 'Array of records as JSON' :
 format === 'csv' ? 'Comma-separated values with header row' :
 'One JSON object per line (streaming-friendly)'}
 </p>
 </div>

 <div class="form-control">
 <div class="label">
 <span class="label-text font-medium">Row limit</span>
 <span class="label-text-alt text-base-content/50">max 10,000</span>
 </div>
 <input type="number" class="input" bind:value={limit}
 min="1" max="10000" step="100" />
 </div>

 {#if error}
 <div class="alert alert-error text-sm">{error}</div>
 {/if}

 <button class="btn btn-primary w-full" onclick={doExport}
 disabled={!selectedCollection || exporting}>
 {#if exporting}
 <LoaderCircle size={16} class="animate-spin" />
 Exporting…
 {:else}
 <Download size={16} />
 Export {selectedCollection || 'Collection'}
 {/if}
 </button>
 </div>
 </div>
 </div>

 <div class="divider"></div>

 <div class="prose prose-sm max-w-none">
 <h3 class="text-base font-semibold">Format Notes</h3>
 <div class="grid gap-4 sm:grid-cols-3">
 <div class="card bg-base-200 p-4">
 <p class="font-medium text-sm mb-1">JSON</p>
 <p class="text-xs text-base-content/60">Full records array. Best for importing back into Zveltio or processing with JavaScript.</p>
 </div>
 <div class="card bg-base-200 p-4">
 <p class="font-medium text-sm mb-1">CSV</p>
 <p class="text-xs text-base-content/60">Spreadsheet-compatible. Nested objects are serialized as JSON strings.</p>
 </div>
 <div class="card bg-base-200 p-4">
 <p class="font-medium text-sm mb-1">NDJSON</p>
 <p class="text-xs text-base-content/60">Newline-delimited JSON. Ideal for streaming pipelines and large datasets.</p>
 </div>
 </div>
 </div>
</div>
