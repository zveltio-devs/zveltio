<script lang="ts">
  import { onMount } from 'svelte';
  import { collectionsApi, api } from '$lib/api.js';
  import { Upload, CheckCircle, XCircle, Loader2, FileText } from '@lucide/svelte';

  let collections = $state<any[]>([]);
  let selectedCollection = $state('');
  let file = $state<File | null>(null);
  let delimiter = $state(',');
  let jobs = $state<any[]>([]);
  let loading = $state(true);
  let importing = $state(false);
  let activeJob = $state<any>(null);
  let pollInterval: any = null;
  let preview = $state<any>(null);
  let previewing = $state(false);

  onMount(async () => {
    const [colRes, jobsRes] = await Promise.all([
      collectionsApi.list(),
      api.get<{ jobs: any[] }>('/api/import/jobs'),
    ]);
    collections = colRes.collections || [];
    jobs = jobsRes.jobs || [];
    if (collections.length > 0) selectedCollection = collections[0].name;
    loading = false;
  });

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    file = input.files?.[0] || null;
    preview = null;
  }

  async function previewFile() {
    if (!file || !selectedCollection) return;
    previewing = true;
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('delimiter', delimiter);
      const res = await fetch(`${import.meta.env.VITE_ENGINE_URL || ''}/api/import/${selectedCollection}/preview`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      preview = await res.json();
    } catch (err: any) {
      alert('Preview failed: ' + err.message);
    } finally {
      previewing = false;
    }
  }

  async function runImport() {
    if (!file || !selectedCollection) return;
    importing = true;
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('delimiter', delimiter);
      const res = await fetch(`${import.meta.env.VITE_ENGINE_URL || ''}/api/import/${selectedCollection}`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data = await res.json();
      activeJob = { id: data.job_id, status: 'processing' };
      jobs = [activeJob, ...jobs];
      startPolling(data.job_id);
    } catch (err: any) {
      alert('Import failed: ' + err.message);
    } finally {
      importing = false;
    }
  }

  function startPolling(jobId: string) {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      const res = await api.get<{ job: any }>(`/api/import/jobs/${jobId}`);
      activeJob = res.job;
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx >= 0) jobs[idx] = res.job;
      if (['completed', 'failed', 'partial'].includes(res.job.status)) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }, 1500);
  }

  function statusBadge(status: string) {
    const map: Record<string, string> = {
      pending: 'badge-warning',
      processing: 'badge-info',
      completed: 'badge-success',
      partial: 'badge-warning',
      failed: 'badge-error',
    };
    return map[status] || 'badge-ghost';
  }

  function progress(job: any): number {
    if (!job.total_rows || job.total_rows === 0) return 0;
    return Math.round((job.processed_rows / job.total_rows) * 100);
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold">Import Data</h1>
    <p class="text-base-content/60 text-sm">Upload CSV or JSON files to import records into a collection</p>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
    <!-- Upload form -->
    <div class="card bg-base-200">
      <div class="card-body gap-4">
        <h2 class="font-semibold">Upload File</h2>

        <div class="form-control">
          <label class="label" for="col_sel"><span class="label-text">Target collection</span></label>
          <select id="col_sel" bind:value={selectedCollection} class="select select-bordered select-sm">
            {#each collections as col}
              <option value={col.name}>{col.display_name || col.name}</option>
            {/each}
          </select>
        </div>

        <div class="form-control">
          <label class="label"><span class="label-text">File (CSV or JSON)</span></label>
          <input
            type="file"
            accept=".csv,.json,.txt"
            class="file-input file-input-bordered file-input-sm w-full"
            onchange={handleFileChange}
          />
        </div>

        {#if file?.name?.endsWith('.csv') || file?.name?.endsWith('.txt')}
          <div class="form-control">
            <label class="label" for="delim"><span class="label-text">Delimiter</span></label>
            <select id="delim" bind:value={delimiter} class="select select-bordered select-sm w-32">
              <option value=",">Comma (,)</option>
              <option value=";">Semicolon (;)</option>
              <option value="\t">Tab</option>
              <option value="|">Pipe (|)</option>
            </select>
          </div>
        {/if}

        <div class="flex gap-2 flex-wrap">
          <button
            class="btn btn-outline btn-sm"
            onclick={previewFile}
            disabled={!file || !selectedCollection || previewing}
          >
            {#if previewing}
              <Loader2 size={14} class="animate-spin" />
            {:else}
              <FileText size={14} />
            {/if}
            Preview
          </button>

          <button
            class="btn btn-primary btn-sm"
            onclick={runImport}
            disabled={!file || !selectedCollection || importing}
          >
            {#if importing}
              <Loader2 size={14} class="animate-spin" />
              Starting…
            {:else}
              <Upload size={14} />
              Import
            {/if}
          </button>
        </div>

        <!-- Preview table -->
        {#if preview}
          <div class="mt-2">
            <p class="text-xs text-base-content/60 mb-2">
              Preview: first {preview.preview?.length} of {preview.total_rows} rows
            </p>
            <div class="overflow-x-auto max-h-48">
              <table class="table table-xs">
                <thead>
                  <tr>
                    {#each preview.headers || [] as h}
                      <th>{h}</th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each preview.preview || [] as row}
                    <tr>
                      {#each preview.headers || [] as h}
                        <td class="max-w-24 truncate">{row[h] ?? ''}</td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- Active job status -->
    {#if activeJob}
      <div class="card bg-base-200">
        <div class="card-body">
          <h2 class="font-semibold">Import Progress</h2>
          <div class="space-y-3">
            <div class="flex items-center gap-2">
              <span class="badge badge-sm {statusBadge(activeJob.status)}">{activeJob.status}</span>
              <span class="text-sm">{activeJob.filename}</span>
            </div>
            <progress
              class="progress progress-primary w-full"
              value={progress(activeJob)}
              max="100"
            ></progress>
            <div class="grid grid-cols-3 gap-2 text-center">
              <div class="stat p-2">
                <div class="stat-title text-xs">Total</div>
                <div class="stat-value text-lg">{activeJob.total_rows || 0}</div>
              </div>
              <div class="stat p-2">
                <div class="stat-title text-xs">Success</div>
                <div class="stat-value text-lg text-success">{activeJob.success_rows || 0}</div>
              </div>
              <div class="stat p-2">
                <div class="stat-title text-xs">Errors</div>
                <div class="stat-value text-lg text-error">{activeJob.error_rows || 0}</div>
              </div>
            </div>
            {#if activeJob.errors?.length > 0}
              <div class="overflow-y-auto max-h-32 bg-error/10 rounded p-2 text-xs space-y-1">
                {#each (typeof activeJob.errors === 'string' ? JSON.parse(activeJob.errors) : activeJob.errors).slice(0, 10) as err}
                  <div class="text-error">Row {err.row}: {err.error}</div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- Import history -->
  <div class="card bg-base-200">
    <div class="card-body">
      <h2 class="font-semibold">Import History</h2>
      {#if loading}
        <div class="flex justify-center py-6"><span class="loading loading-spinner"></span></div>
      {:else if jobs.length === 0}
        <p class="text-center py-6 text-base-content/40">No imports yet.</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <th>File</th>
                <th>Collection</th>
                <th>Status</th>
                <th>Total</th>
                <th>Success</th>
                <th>Errors</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {#each jobs as job}
                <tr>
                  <td class="font-mono text-xs max-w-32 truncate" title={job.filename}>{job.filename}</td>
                  <td>{job.collection}</td>
                  <td><span class="badge badge-sm {statusBadge(job.status)}">{job.status}</span></td>
                  <td>{job.total_rows}</td>
                  <td class="text-success">{job.success_rows}</td>
                  <td class="text-error">{job.error_rows}</td>
                  <td class="text-xs text-base-content/50">
                    {new Date(job.created_at).toLocaleString()}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </div>
</div>
