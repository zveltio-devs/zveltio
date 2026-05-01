<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Activity } from '@lucide/svelte';

  interface LogEntry {
    id: number;
    method: string;
    path: string;
    status: number;
    duration_ms: number;
    user_id: string | null;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
  }

  let logs = $state<LogEntry[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let page = $state(1);
  const limit = 100;

  // Filters
  let filterPath = $state('');
  let filterStatus = $state('');
  let filterMethod = $state('');

  async function load() {
    loading = true;
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (filterPath) params.set('path', filterPath);
      if (filterStatus) params.set('status', filterStatus);
      if (filterMethod) params.set('method', filterMethod);
      const res = await api.get<{ logs: LogEntry[]; total: number }>(`/api/admin/logs?${params}`);
      logs = res.logs;
      total = res.total;
    } catch { /* ignore */ } finally {
      loading = false;
    }
  }

  onMount(load);

  function statusColor(status: number) {
    if (status < 300) return 'badge-success';
    if (status < 400) return 'badge-info';
    if (status < 500) return 'badge-warning';
    return 'badge-error';
  }

  function methodColor(method: string) {
    const map: Record<string, string> = { GET: 'badge-info', POST: 'badge-success', PATCH: 'badge-warning', PUT: 'badge-warning', DELETE: 'badge-error' };
    return map[method] ?? 'badge-ghost';
  }

  function applyFilters() { page = 1; load(); }
</script>

<div class="p-6">
  <div class="flex items-center gap-3 mb-6">
    <Activity class="w-6 h-6 text-primary" />
    <div>
      <h1 class="text-2xl font-bold">Request Logs</h1>
      <p class="text-base-content/60 text-sm">All API requests — filterable by path, method, status.</p>
    </div>
  </div>

  <!-- Filters -->
  <div class="flex flex-wrap gap-3 mb-4">
    <input
      class="input input-bordered input-sm w-56"
      placeholder="Filter by path..."
      bind:value={filterPath}
      onkeydown={(e) => e.key === 'Enter' && applyFilters()}
    />
    <select class="select select-bordered select-sm" bind:value={filterMethod} onchange={applyFilters}>
      <option value="">All methods</option>
      {#each ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as m}
        <option value={m}>{m}</option>
      {/each}
    </select>
    <select class="select select-bordered select-sm" bind:value={filterStatus} onchange={applyFilters}>
      <option value="">All statuses</option>
      {#each ['200', '201', '400', '401', '403', '404', '500'] as s}
        <option value={s}>{s}</option>
      {/each}
    </select>
    <button class="btn btn-sm btn-primary" onclick={applyFilters}>Apply</button>
    <span class="ml-auto text-sm text-base-content/50 self-center">{total.toLocaleString()} total</span>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-md"></span></div>
  {:else if logs.length === 0}
    <div class="text-center py-16 text-base-content/40">
      <Activity class="w-10 h-10 mx-auto mb-3 opacity-30" />
      <p>No requests logged yet.</p>
    </div>
  {:else}
    <div class="overflow-x-auto rounded-xl border border-base-300">
      <table class="table table-sm table-zebra w-full">
        <thead>
          <tr>
            <th>Time</th>
            <th>Method</th>
            <th>Path</th>
            <th>Status</th>
            <th>Duration</th>
            <th>User</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {#each logs as log}
            <tr>
              <td class="font-mono text-xs whitespace-nowrap">{new Date(log.created_at).toLocaleTimeString()}</td>
              <td><span class="badge badge-xs {methodColor(log.method)}">{log.method}</span></td>
              <td class="font-mono text-xs max-w-xs truncate" title={log.path}>{log.path}</td>
              <td><span class="badge badge-xs {statusColor(log.status)}">{log.status}</span></td>
              <td class="text-xs {log.duration_ms > 500 ? 'text-warning font-bold' : ''}">{log.duration_ms}ms</td>
              <td class="font-mono text-xs truncate max-w-[8rem]" title={log.user_id ?? ''}>{log.user_id ? log.user_id.slice(0, 8) + '…' : '—'}</td>
              <td class="font-mono text-xs">{log.ip ?? '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    {#if total > limit}
      <div class="flex justify-center gap-2 mt-4">
        <button class="btn btn-sm" onclick={() => { page--; load(); }} disabled={page === 1}>←</button>
        <span class="btn btn-sm btn-ghost no-animation">Page {page} / {Math.ceil(total / limit)}</span>
        <button class="btn btn-sm" onclick={() => { page++; load(); }} disabled={page >= Math.ceil(total / limit)}>→</button>
      </div>
    {/if}
  {/if}
</div>
