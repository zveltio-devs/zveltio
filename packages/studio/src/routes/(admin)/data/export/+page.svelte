<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { Download, Plus, X } from '@lucide/svelte';
import { api as zApi } from '$lib/api.js';
import { ENGINE_URL } from '$lib/config.js';

// engineUrl stays — it backs the direct <window.open> download link
// below. Programmatic JSON calls go through zApi.
const engineUrl = ENGINE_URL;
let jobs = $state<any[]>([]);
let collections = $state<any[]>([]);
let error = $state('');

let showForm = $state(false);
let saving = $state(false);
let form = $state({
  collection: '',
  format: 'csv' as 'csv' | 'json' | 'ndjson' | 'xlsx',
  filter: '',
  limit: 0,
});

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await zApi.fetch(path, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}
async function load() {
  try {
    const r = await api('/ext/data/export/jobs');
    jobs = r.data ?? r.audit ?? [];
  } catch (e: any) {
    error = e.message;
  }
}
async function loadCollections() {
  try {
    const r = await api('/api/collections');
    collections = r.collections ?? r.data ?? [];
  } catch {}
}

function downloadUrl(): string {
  const params = new URLSearchParams({ format: form.format });
  if (form.filter) params.set('filter', form.filter);
  if (form.limit > 0) params.set('limit', String(form.limit));
  return `${engineUrl}/ext/data/export/${encodeURIComponent(form.collection)}?${params}`;
}

function startExport() {
  if (!form.collection) return;
  window.open(downloadUrl(), '_blank');
  showForm = false;
  setTimeout(load, 1000);
}

onMount(() => {
  load();
  loadCollections();
});

function fmtBytes(n: number) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n > 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${u[i]}`;
}
</script>

<ExtensionPageShell title={m['data.export.title']()} subtitle={m['data.export.subtitle']()}>
{#if error}<div class="alert alert-error">{error}</div>{/if}

  <div class="overflow-x-auto bg-base-100 rounded-lg shadow">
    <table class="table table-sm">
      <thead><tr><th>{m['data.export.col.time']()}</th><th>{m['common.col.collection']()}</th><th>{m['data.export.col.format']()}</th><th>{m['data.export.col.rows']()}</th><th>{m['data.export.col.size']()}</th><th>{m['data.export.col.user']()}</th></tr></thead>
      <tbody>
        {#if jobs.length === 0}<tr><td colspan="6" class="text-center py-6 text-base-content/60">{m['data.export.ui.no_exports_recorded']()}</td></tr>
        {:else}{#each jobs as j (j.id)}
          <tr><td>{j.created_at?.slice(0, 16).replace('T', ' ')}</td><td>{j.collection}</td><td><span class="badge badge-ghost badge-sm">{j.format}</span></td><td>{j.row_count?.toLocaleString() ?? '—'}</td><td>{fmtBytes(Number(j.size_bytes ?? 0))}</td><td>{j.user_id}</td></tr>
        {/each}{/if}
      </tbody>
    </table>
  </div>
</ExtensionPageShell>

{#if showForm}
  <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onclick={(e) => e.target === e.currentTarget && (showForm = false)}>
    <div class="bg-base-100 rounded-xl p-6 w-full max-w-md">
      <div class="flex items-center justify-between mb-4"><h2 class="text-xl font-semibold">{m['data.export.ui.export_collection']()}</h2><button class="btn btn-ghost btn-sm btn-square" onclick={() => (showForm = false)}><X class="h-4 w-4" /></button></div>
      <div class="space-y-3">
        <div>
          <label class="label label-text">{m['data.export.col.collection']()}</label>
          <select class="select select-bordered w-full" bind:value={form.collection}>
            <option value="">{m['data.export.ui.select']()}</option>
            {#each collections as c (c.name)}<option value={c.name}>{c.display_name ?? c.name}</option>{/each}
          </select>
        </div>
        <div>
          <label class="label label-text">{m['data.export.col.format']()}</label>
          <select class="select select-bordered w-full" bind:value={form.format}>
            <option value="csv">CSV</option><option value="json">JSON</option><option value="ndjson">NDJSON</option><option value="xlsx">{m['data.export.ui.excel_xlsx']()}</option>
          </select>
        </div>
        <div><label class="label label-text">{m['data.export.filterHint']()}</label><input class="input input-bordered w-full font-mono text-xs" bind:value={form.filter} placeholder='status=active' /></div>
        <div><label class="label label-text">Row limit (0 = all)</label><input type="number" class="input input-bordered w-full" bind:value={form.limit} /></div>
      </div>
      <div class="flex justify-end gap-2 mt-4"><button class="btn btn-ghost" onclick={() => (showForm = false)}>{m['common.cancel']()}</button><button class="btn btn-primary gap-2" disabled={!form.collection} onclick={startExport}><Download class="h-4 w-4" /> {m['data.export.btn.download']()}</button></div>
    </div>
  </div>
{/if}
{#if showForm}
  <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onclick={(e) => e.target === e.currentTarget && (showForm = false)}>
    <div class="bg-base-100 rounded-xl p-6 w-full max-w-md">
      <div class="flex items-center justify-between mb-4"><h2 class="text-xl font-semibold">{m['data.export.ui.export_collection']()}</h2><button class="btn btn-ghost btn-sm btn-square" onclick={() => (showForm = false)}><X class="h-4 w-4" /></button></div>
      <div class="space-y-3">
        <div>
          <label class="label label-text">{m['data.export.col.collection']()}</label>
          <select class="select select-bordered w-full" bind:value={form.collection}>
            <option value="">{m['data.export.ui.select']()}</option>
            {#each collections as c (c.name)}<option value={c.name}>{c.display_name ?? c.name}</option>{/each}
          </select>
        </div>
        <div>
          <label class="label label-text">{m['data.export.col.format']()}</label>
          <select class="select select-bordered w-full" bind:value={form.format}>
            <option value="csv">CSV</option><option value="json">JSON</option><option value="ndjson">NDJSON</option><option value="xlsx">{m['data.export.ui.excel_xlsx']()}</option>
          </select>
        </div>
        <div><label class="label label-text">{m['data.export.filterHint']()}</label><input class="input input-bordered w-full font-mono text-xs" bind:value={form.filter} placeholder='status=active' /></div>
        <div><label class="label label-text">Row limit (0 = all)</label><input type="number" class="input input-bordered w-full" bind:value={form.limit} /></div>
      </div>
      <div class="flex justify-end gap-2 mt-4"><button class="btn btn-ghost" onclick={() => (showForm = false)}>{m['common.cancel']()}</button><button class="btn btn-primary gap-2" disabled={!form.collection} onclick={startExport}><Download class="h-4 w-4" /> {m['data.export.btn.download']()}</button></div>
    </div>
  </div>
{/if}
