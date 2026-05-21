<script lang="ts">
  import { onMount } from 'svelte';
  import { Upload, X, AlertCircle, CheckCircle } from '@lucide/svelte';

  const engineUrl = (window as any).__zveltio?.engineUrl ?? '';
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
    const res = await fetch(`${engineUrl}${path}`, { credentials: 'include', ...init });
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
      const res = await fetch(`${engineUrl}/ext/data/import/${encodeURIComponent(form.collection)}`, {
        method: 'POST', credentials: 'include', body: fd,
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

<div class="p-6 space-y-4">
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold flex items-center gap-2"><Upload class="h-6 w-6" /> Data Import</h1>
    <button class="btn btn-primary btn-sm gap-2" onclick={() => { showForm = true; result = null; }}><Upload class="h-4 w-4" /> New import</button>
  </header>
  {#if error}<div class="alert alert-error"><AlertCircle class="h-4 w-4" /> {error}</div>{/if}

  <div class="overflow-x-auto bg-base-100 rounded-lg shadow">
    <table class="table table-sm">
      <thead><tr><th>Time</th><th>Collection</th><th>Format</th><th>Rows</th><th>Errors</th><th>Status</th></tr></thead>
      <tbody>
        {#if jobs.length === 0}<tr><td colspan="6" class="text-center py-6 text-base-content/60">No imports yet.</td></tr>
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
</div>

{#if showForm}
  <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onclick={(e) => e.target === e.currentTarget && (showForm = false)}>
    <div class="bg-base-100 rounded-xl p-6 w-full max-w-lg">
      <div class="flex items-center justify-between mb-4"><h2 class="text-xl font-semibold">Import data</h2><button class="btn btn-ghost btn-sm btn-square" onclick={() => (showForm = false)}><X class="h-4 w-4" /></button></div>
      <div class="space-y-3">
        <div>
          <label class="label label-text">Target collection</label>
          <select class="select select-bordered w-full" bind:value={form.collection}>
            <option value="">— Select —</option>
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
              <div class="text-sm text-base-content/60">Drag a CSV / JSON / NDJSON file, or click to browse</div>
            {/if}
          </label>
        </div>
        <div>
          <label class="label label-text">Format</label>
          <select class="select select-bordered w-full" bind:value={form.format}><option value="csv">CSV</option><option value="json">JSON</option><option value="ndjson">NDJSON</option></select>
        </div>
        <div><label class="label label-text">Upsert on field (optional, e.g. <code class="text-xs">email</code>)</label><input class="input input-bordered w-full font-mono" bind:value={form.upsert_on} /></div>
        <label class="label cursor-pointer gap-2"><input type="checkbox" class="checkbox checkbox-sm" bind:checked={form.create_missing_columns} /><span class="label-text">Create missing columns automatically</span></label>
      </div>

      {#if result}
        <div class="alert alert-success mt-3 text-sm">
          <CheckCircle class="h-4 w-4" />
          <div>
            <div class="font-medium">Imported {result.rows_imported ?? '?'} rows</div>
            {#if result.errors?.length}<div class="text-xs">{result.errors.length} errors — see job log</div>{/if}
          </div>
        </div>
      {/if}

      <div class="flex justify-end gap-2 mt-4"><button class="btn btn-ghost" onclick={() => (showForm = false)}>Close</button><button class="btn btn-primary gap-2" disabled={uploading || !form.file || !form.collection} onclick={startImport}><Upload class="h-4 w-4" /> {uploading ? 'Uploading…' : 'Import'}</button></div>
    </div>
  </div>
{/if}
