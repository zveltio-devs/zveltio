<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
    import { onMount } from 'svelte';
  import { Upload, X, AlertCircle, CheckCircle } from '@lucide/svelte';
  import { api as zApi } from '$lib/api.js';

  let jobs = $state<any[]>([]);
  let collections = $state<any[]>([]);
  let error = $state('');

  let showForm = $state(false);
  let uploading = $state(false);
  let dragOver = $state(false);
  let result = $state<any | null>(null);

  let form = $state({
    collection: '',
    format: 'csv' as 'csv' | 'json' | 'ndjson',
    upsert_on: '',
    create_missing_columns: false,
    file: null as File | null,
  });

  async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
    const res = await zApi.fetch(path, init);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json as T;
  }
  async function load() { try { const r = await api('/ext/data/import/logs?limit=50'); jobs = r.data ?? []; } catch (e: any) { error = e.message; } }
  async function loadCollections() { try { const r = await api('/api/collections'); collections = r.collections ?? r.data ?? []; } catch {} }

  function setFile(f: File | null) {
    form.file = f;
    if (f && !form.collection) {
      // Auto-detect format from extension
      const ext = f.name.toLowerCase().split('.').pop();
      if (ext === 'json') form.format = 'json';
      else if (ext === 'ndjson' || ext === 'jsonl') form.format = 'ndjson';
      else form.format = 'csv';
    }
  }

  async function startImport() {
    if (!form.file || !form.collection) return;
    uploading = true; error = ''; result = null;
    try {
      const fd = new FormData();
      fd.append('file', form.file);
      fd.append('format', form.format);
      if (form.upsert_on) fd.append('upsert_on', form.upsert_on);
      fd.append('create_missing_columns', String(form.create_missing_columns));
      const res = await zApi.fetch(`/ext/data/import/${encodeURIComponent(form.collection)}`, {
        method: 'POST', body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      result = json;
      await load();
    } catch (e: any) { error = e.message; }
    finally { uploading = false; }
  }

  onMount(() => { load(); loadCollections(); });

  function fmtBytes(n: number) { if (!n) return '—'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n > 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(1)} ${u[i]}`; }
</script>

<ExtensionPageShell title={m['data.import.title']()} subtitle={m['data.import.subtitle']()}>
  {#snippet children()}
{#if error}<div class="alert alert-error"><AlertCircle class="h-4 w-4" /> {error}</div>{/if}

  <div class="overflow-x-auto bg-base-100 rounded-lg shadow">
    <table class="table table-sm">
      <thead><tr><th>{m['data.import.col.time']()}</th><th>{m['common.col.collection']()}</th><th>{m['data.import.col.format']()}</th><th>{m['data.import.col.rows']()}</th><th>{m['data.import.col.errors']()}</th><th>{m['common.col.status']()}</th></tr></thead>
      <tbody>
        {#if jobs.length === 0}<tr><td colspan="6" class="text-center py-6 text-base-content/60">{m['data.import.empty']()}</td></tr>
        {:else}{#each jobs as j (j.id)}
          <tr>
            <td>{j.created_at?.slice(0, 16).replace('T', ' ')}</td>
            <td>{j.collection}</td>
            <td><span class="badge badge-ghost badge-sm">{j.format}</span></td>
            <td>{j.rows_imported ?? '—'} / {j.total_rows ?? '?'}</td>
            <td>{j.error_count ?? 0}</td>
            <td><span class="badge {j.status === 'completed' ? 'badge-success' : j.status === 'failed' ? 'badge-error' : 'badge-warning'} badge-sm">{j.status}</span></td>
          </tr>
        {/each}{/if}
      </tbody>
    </table>
  </div>
  {/snippet}
</ExtensionPageShell>

{#if showForm}
  <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onclick={(e) => e.target === e.currentTarget && (showForm = false)}>
    <div class="bg-base-100 rounded-xl p-6 w-full max-w-lg">
      <div class="flex items-center justify-between mb-4"><h2 class="text-xl font-semibold">{m['data.import.form.title']()}</h2><button class="btn btn-ghost btn-sm btn-square" onclick={() => (showForm = false)}><X class="h-4 w-4" /></button></div>
      <div class="space-y-3">
        <div>
          <label class="label label-text">{m['data.import.form.collection']()}</label>
          <select class="select select-bordered w-full" bind:value={form.collection}>
            <option value="">{m['data.export.ui.select']()}</option>
            {#each collections as c (c.name)}<option value={c.name}>{c.display_name ?? c.name}</option>{/each}
          </select>
        </div>
        <div
          class="border-2 border-dashed rounded-lg p-6 text-center transition cursor-pointer"
          class:border-primary={dragOver}
          ondragover={(e) => { e.preventDefault(); dragOver = true; }}
          ondragleave={() => (dragOver = false)}
          ondrop={(e) => { e.preventDefault(); dragOver = false; setFile(e.dataTransfer?.files?.[0] ?? null); }}
        >
          <input id="import-file" type="file" class="hidden" accept=".csv,.json,.ndjson,.jsonl" onchange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
          <label for="import-file" class="cursor-pointer block">
            {#if form.file}
              <div class="font-medium">{form.file.name}</div>
              <div class="text-xs text-base-content/60">{fmtBytes(form.file.size)}</div>
            {:else}
              <Upload class="h-8 w-8 mx-auto mb-2 text-base-content/40" />
              <div class="text-sm text-base-content/60">{m['data.import.dropHint']()}</div>
            {/if}
          </label>
        </div>
        <div>
          <label class="label label-text">{m['data.import.label.format']()}</label>
          <select class="select select-bordered w-full" bind:value={form.format}><option value="csv">CSV</option><option value="json">JSON</option><option value="ndjson">NDJSON</option></select>
        </div>
        <div><label class="label label-text">{m['data.import.label.upsertHtml']()}</label><input class="input input-bordered w-full font-mono" bind:value={form.upsert_on} /></div>
        <label class="label cursor-pointer gap-2"><input type="checkbox" class="checkbox checkbox-sm" bind:checked={form.create_missing_columns} /><span class="label-text">{m['data.import.ui.create_missing_columns_automatically']()}</span></label>
      </div>

      {#if result}
        <div class="alert alert-success mt-3 text-sm">
          <CheckCircle class="h-4 w-4" />
          <div>
            <div class="font-medium">{m['data.import.toast.imported']({ n: String(result.rows_imported ?? '?') })}</div>
            {#if result.errors?.length}<div class="text-xs">{m['data.import.errorsHint']({ n: String(result.errors.length) })}</div>{/if}
          </div>
        </div>
      {/if}

      <div class="flex justify-end gap-2 mt-4"><button class="btn btn-ghost" onclick={() => (showForm = false)}>{m['common.close']()}</button><button class="btn btn-primary gap-2" disabled={uploading || !form.file || !form.collection} onclick={startImport}><Upload class="h-4 w-4" /> {uploading ? m['common.uploading']() : m['data.import.action.import']()}</button></div>
    </div>
  </div>
{/if}
