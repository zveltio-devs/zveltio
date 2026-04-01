<script lang="ts">
 import { api } from '$lib/api.js';
 import { ScanSearch, RefreshCw, Download, CheckCircle, AlertCircle, Eye } from '@lucide/svelte';
 import PageHeader from '$lib/components/common/PageHeader.svelte';

 type TablePreview = {
 tableName: string;
 collectionName: string;
 fieldsCount: number;
 isNew: boolean;
 };

 let schema = $state('public');
 let excludeInput = $state('');
 let previewing = $state(false);
 let importing = $state(false);
 let error = $state('');
 let previewTables = $state<TablePreview[]>([]);
 let importResult = $state<{ imported: number; updated: number; tables: TablePreview[] } | null>(null);
 let previewed = $state(false);

 function excludeList(): string[] {
 return excludeInput.split(',').map((s) => s.trim()).filter(Boolean);
 }

 async function preview() {
 previewing = true;
 error = '';
 importResult = null;
 try {
 const params = new URLSearchParams({ schema });
 const ex = excludeList();
 if (ex.length) params.set('exclude', ex.join(','));
 const res = await api.get<{ tables: TablePreview[] }>(`/api/introspect/preview?${params}`);
 previewTables = res.tables ?? [];
 previewed = true;
 } catch (e: any) {
 error = e.message || 'Preview failed';
 } finally {
 previewing = false;
 }
 }

 async function importTables() {
 importing = true;
 error = '';
 try {
 const res = await api.post<{ imported: number; updated: number; tables: TablePreview[] }>('/api/introspect', {
 schema,
 exclude: excludeList(),
 });
 importResult = res;
 previewTables = [];
 previewed = false;
 } catch (e: any) {
 error = e.message || 'Import failed';
 } finally {
 importing = false;
 }
 }
</script>

<div class="space-y-6">
 <PageHeader title="BYOD Import" subtitle="Import tables from an external database" />

 {#if error}
 <div class="alert alert-error mb-4">
 <AlertCircle size={16} />
 <span>{error}</span>
 </div>
 {/if}

 <!-- Config -->
 <div class="card bg-base-200 mb-6">
 <div class="card-body">
 <h2 class="card-title text-base">Configurare</h2>
 <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
 <label class="form-control">
 <div class="label"><span class="label-text">Schema PostgreSQL</span></div>
 <input
 type="text"
 class="input"
 placeholder="public"
 bind:value={schema}
 />
 </label>
 <label class="form-control">
 <div class="label">
 <span class="label-text">Exclude (subșiruri, separate cu virgulă)</span>
 </div>
 <input
 type="text"
 class="input"
 placeholder="temp_, _test, legacy"
 bind:value={excludeInput}
 />
 </label>
 </div>
 <div class="card-actions mt-2">
 <button class="btn btn-outline btn-sm" onclick={preview} disabled={previewing || importing}>
 <Eye size={14} class={previewing ? 'animate-spin' : ''} />
 {previewing ? 'Se scanează...' : 'Preview'}
 </button>
 </div>
 </div>
 </div>

 <!-- Preview results -->
 {#if previewed && previewTables.length > 0}
 <div class="card bg-base-200 mb-6">
 <div class="card-body">
 <div class="flex items-center justify-between mb-3">
 <h2 class="card-title text-base">
 {previewTables.length} tabele găsite în schema <code class="text-primary">{schema}</code>
 </h2>
 <button class="btn btn-primary btn-sm" onclick={importTables} disabled={importing}>
 <Download size={14} class={importing ? 'animate-spin' : ''} />
 {importing ? 'Se importă...' : 'Import ca Unmanaged Collections'}
 </button>
 </div>
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 <th>Tabel</th>
 <th>Colecție Zveltio</th>
 <th class="text-right">Câmpuri</th>
 </tr>
 </thead>
 <tbody>
 {#each previewTables as t}
 <tr>
 <td class="font-mono text-sm">{t.tableName}</td>
 <td class="font-mono text-sm text-primary">{t.collectionName}</td>
 <td class="text-right">
 <span class="badge badge-ghost badge-sm">{t.fieldsCount}</span>
 </td>
 </tr>
 {/each}
 </tbody>
 </table>
 </div>
 </div>
 </div>
 {/if}

 {#if previewed && previewTables.length === 0}
 <div class="alert alert-info mb-6">
 <ScanSearch size={16} />
 <span>Nu s-au găsit tabele eligibile în schema <strong>{schema}</strong>. Tabelele cu prefix <code>zv_</code>, <code>zvd_</code>, <code>_zv_</code>, <code>pg_</code> sunt excluse automat.</span>
 </div>
 {/if}

 <!-- Import result -->
 {#if importResult}
 <div class="card bg-base-200 mb-6">
 <div class="card-body">
 <div class="flex items-center gap-2 mb-3">
 <CheckCircle size={20} class="text-success" />
 <h2 class="card-title text-base text-success">Import finalizat</h2>
 </div>
 <div class="stats stats-horizontal shadow mb-4">
 <div class="stat">
 <div class="stat-title">Importate (noi)</div>
 <div class="stat-value text-primary">{importResult.imported}</div>
 </div>
 <div class="stat">
 <div class="stat-title">Actualizate</div>
 <div class="stat-value">{importResult.updated}</div>
 </div>
 <div class="stat">
 <div class="stat-title">Total</div>
 <div class="stat-value">{importResult.tables.length}</div>
 </div>
 </div>
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 <th>Tabel</th>
 <th>Colecție Zveltio</th>
 <th class="text-right">Câmpuri</th>
 <th class="text-right">Status</th>
 </tr>
 </thead>
 <tbody>
 {#each importResult.tables as t}
 <tr>
 <td class="font-mono text-sm">{t.tableName}</td>
 <td class="font-mono text-sm text-primary">{t.collectionName}</td>
 <td class="text-right">
 <span class="badge badge-ghost badge-sm">{t.fieldsCount}</span>
 </td>
 <td class="text-right">
 {#if t.isNew}
 <span class="badge badge-success badge-sm">Nou</span>
 {:else}
 <span class="badge badge-info badge-sm">Actualizat</span>
 {/if}
 </td>
 </tr>
 {/each}
 </tbody>
 </table>
 </div>
 <p class="text-xs text-base-content/50 mt-3">
 Colecțiile importate sunt marcate ca <strong>is_managed = false</strong>.
 Zveltio nu va executa ALTER TABLE pe aceste tabele.
 </p>
 </div>
 </div>
 {/if}

 <!-- Info box -->
 <div class="alert alert-warning">
 <AlertCircle size={16} />
 <div class="text-sm">
 <strong>BYOD (Bring Your Own Database)</strong> — Colecțiile importate sunt read-write via API,
 dar Zveltio nu va modifica schema lor (fără ADD COLUMN, DROP COLUMN, ALTER TABLE).
 Dacă vrei să gestionezi schema, marchează manual <code>is_managed = true</code> din Collections.
 </div>
 </div>
</div>
