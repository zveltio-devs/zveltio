<script lang="ts">
 import { onMount } from 'svelte';
 import { api, collectionsApi } from '$lib/api.js';
 import { Upload, CheckCircle, AlertCircle, RefreshCw, LoaderCircle } from '@lucide/svelte';

 let collections = $state<any[]>([]);
 let selectedCollection = $state('');
 let file = $state<File | null>(null);
 let format = $state<'csv' | 'xlsx' | 'json'>('csv');
 let delimiter = $state(',');
 let skipHeader = $state(true);
 let importing = $state(false);
 let result = $state<any>(null);
 let jobs = $state<any[]>([]);
 let jobsLoading = $state(true);

 onMount(async () => {
 const res = await collectionsApi.list();
 collections = res.collections || [];
 await loadJobs();
 });

 async function loadJobs() {
 jobsLoading = true;
 try {
 // NOTE: endpoint is /api/import/jobs (not /logs)
 const data = await api.get<{ jobs: any[] }>('/api/import/jobs');
 jobs = data.jobs || [];
 } catch { jobs = []; }
 finally { jobsLoading = false; }
 }

 function handleFile(e: Event) {
 const f = (e.target as HTMLInputElement).files?.[0];
 if (!f) return;
 file = f;
 const ext = f.name.split('.').pop()?.toLowerCase();
 if (ext === 'csv') format = 'csv';
 else if (ext === 'xlsx' || ext === 'xls') format = 'xlsx';
 else if (ext === 'json') format = 'json';
 result = null;
 }

 async function doImport() {
 if (!selectedCollection || !file) return;
 importing = true; result = null;
 try {
 const fd = new FormData();
 fd.append('file', file);
 fd.append('format', format);
 fd.append('skip_header', String(skipHeader));
 fd.append('delimiter', delimiter);
 const res = await fetch(`/api/import/${selectedCollection}`, {
 method: 'POST', credentials: 'include', body: fd,
 });
 result = await res.json();
 if (res.ok) { file = null; await loadJobs(); }
 } catch (err) {
 result = { error: err instanceof Error ? err.message : 'Import failed' };
 } finally { importing = false; }
 }

 function statusClass(s: string) {
 return s === 'completed' ? 'badge-success' :
 s === 'failed' ? 'badge-error' :
 s === 'partial' ? 'badge-warning' : 'badge-ghost';
 }

 function fmt(s: string) { return new Date(s).toLocaleString(); }
</script>

<div class="space-y-6">
 <div>
 <h1 class="text-2xl font-bold">Import Data</h1>
 <p class="text-base-content/60 text-sm mt-1">Import CSV, Excel, or JSON into any collection</p>
 </div>

 <div class="grid gap-6 lg:grid-cols-2">
 <!-- Import form -->
 <div class="card bg-base-200">
 <div class="card-body space-y-4">
 <h2 class="font-semibold text-base">New Import</h2>

 <div class="form-control">
 <label class="label" for="import-collection"><span class="label-text font-medium">Target Collection *</span></label>
 <select id="import-collection" class="select" bind:value={selectedCollection}>
 <option value="">— Select collection —</option>
 {#each collections as col}
 <option value={col.name}>{col.display_name || col.name}</option>
 {/each}
 </select>
 </div>

 <div class="form-control">
 <label class="label" for="import-file"><span class="label-text font-medium">File *</span></label>
 <input id="import-file" type="file" class="file-input file-w-full" accept=".csv,.xlsx,.xls,.json"
 onchange={handleFile} />
 {#if file}
 <p class="text-xs text-success mt-1">✓ {file.name} ({(file.size / 1024).toFixed(1)} KB) — format: {format}</p>
 {/if}
 </div>

 {#if format === 'csv'}
 <div class="grid grid-cols-2 gap-3">
 <div class="form-control">
 <label class="label" for="import-delimiter"><span class="label-text">Delimiter</span></label>
 <select id="import-delimiter" class="select select-sm" bind:value={delimiter}>
 <option value=",">, comma</option>
 <option value=";">; semicolon</option>
 <option value="\t">⇥ tab</option>
 <option value="|">| pipe</option>
 </select>
 </div>
 <div class="form-control justify-end">
 <label class="label cursor-pointer justify-start gap-2">
 <input type="checkbox" class="checkbox checkbox-sm" bind:checked={skipHeader} />
 <span class="label-text text-sm">Skip header row</span>
 </label>
 </div>
 </div>
 {/if}

 <button class="btn btn-primary" onclick={doImport}
 disabled={!selectedCollection || !file || importing}>
 {#if importing}<LoaderCircle size={16} class="animate-spin" />{:else}<Upload size={16} />{/if}
 {importing ? 'Importing...' : 'Start Import'}
 </button>

 {#if result}
 <div class="alert {result.error ? 'alert-error' : result.error_rows > 0 ? 'alert-warning' : 'alert-success'} text-sm">
 {#if result.error}
 <AlertCircle size={18} /><span>{result.error}</span>
 {:else}
 <CheckCircle size={18} />
 <div>
 <p class="font-medium">Import {result.status}</p>
 <p>Total: {result.total_rows ?? 0} | ✓ {result.success_rows ?? 0} | ✗ {result.error_rows ?? 0}</p>
 </div>
 {/if}
 </div>
 {/if}
 </div>
 </div>

 <!-- Recent jobs -->
 <div class="card bg-base-200">
 <div class="card-body">
 <div class="flex items-center justify-between mb-4">
 <h2 class="font-semibold text-base">Recent Imports</h2>
 <button class="btn btn-ghost btn-xs" onclick={loadJobs} title="Refresh"><RefreshCw size={14} /></button>
 </div>
 {#if jobsLoading}
 <div class="flex justify-center py-10"><LoaderCircle size={24} class="animate-spin text-primary" /></div>
 {:else if jobs.length === 0}
 <p class="text-center text-base-content/40 py-10 text-sm">No imports yet</p>
 {:else}
 <div class="space-y-2 max-h-105 overflow-y-auto pr-1">
 {#each jobs as job}
 <div class="p-3 bg-base-300 rounded-lg">
 <div class="flex items-center justify-between">
 <span class="font-medium text-sm">{job.collection}</span>
 <span class="badge badge-sm {statusClass(job.status)}">{job.status}</span>
 </div>
 <p class="text-xs text-base-content/50 truncate">{job.filename || '—'}</p>
 {#if job.total_rows > 0}
 <p class="text-xs mt-0.5">
 {job.total_rows} rows &nbsp;·&nbsp; <span class="text-success">✓ {job.success_rows}</span>
 {#if job.error_rows > 0}&nbsp;·&nbsp; <span class="text-error">✗ {job.error_rows}</span>{/if}
 </p>
 {/if}
 <p class="text-xs text-base-content/30 mt-0.5">{fmt(job.created_at)}</p>
 </div>
 {/each}
 </div>
 {/if}
 </div>
 </div>
 </div>
</div>
