<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { ENGINE_URL } from '$lib/config.js';
  import { Plug, Plus, X, Webhook, ListChecks, LoaderCircle } from '@lucide/svelte';

  let tab = $state<'connections' | 'webhooks' | 'logs'>('connections');
  let connections = $state<any[]>([]);
  let webhooks = $state<any[]>([]);
  let logs = $state<any[]>([]);
  let loading = $state(false);

  let showForm = $state(false);
  let saving = $state(false);
  let form = $state({
    name: '',
    base_url: '',
    auth_type: 'none' as 'none' | 'bearer' | 'basic' | 'oauth2',
    auth_token: '',
    auth_username: '',
    auth_password: '',
    headers: '{}',
  });

  async function loadConnections() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/api/api-connector/connections'); connections = r.data ?? []; }
    catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }
  async function loadWebhooks() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/api/api-connector/incoming-webhooks'); webhooks = r.data ?? []; }
    catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }
  async function loadLogs() {
    loading = true;
    try { const r = await api.get<{ data: any[] }>('/api/api-connector/logs?limit=100'); logs = r.data ?? []; }
    catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function createConnection() {
    saving = true;
    try {
      let extraHeaders: any = {};
      try { extraHeaders = JSON.parse(form.headers); } catch { throw new Error('Invalid JSON in headers'); }
      await api.post('/api/api-connector/connections', { ...form, headers: extraHeaders });
      showForm = false;
      form = { name: '', base_url: '', auth_type: 'none', auth_token: '', auth_username: '', auth_password: '', headers: '{}' };
      await loadConnections();
      toast.success('Connection created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function deleteConnection(id: string) {
    if (!confirm('Delete connection?')) return;
    try { await api.delete(`/api/api-connector/connections/${id}`); await loadConnections(); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  $effect(() => {
    if (tab === 'connections') loadConnections();
    else if (tab === 'webhooks') loadWebhooks();
    else loadLogs();
  });
  onMount(loadConnections);
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><Plug size={20} /> API Connector</h1>
      <p class="text-sm text-base-content/50">External API connections, webhooks, and call logs</p>
    </div>
    {#if tab === 'connections'}<button class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> New connection</button>{/if}
  </div>

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'connections' ? 'tab-active' : ''}" onclick={() => (tab = 'connections')}><Plug size={13} class="mr-1.5" /> Connections</button>
    <button class="tab {tab === 'webhooks' ? 'tab-active' : ''}" onclick={() => (tab = 'webhooks')}><Webhook size={13} class="mr-1.5" /> Incoming webhooks</button>
    <button class="tab {tab === 'logs' ? 'tab-active' : ''}" onclick={() => (tab = 'logs')}><ListChecks size={13} class="mr-1.5" /> Call logs</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'connections'}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {#if connections.length === 0}
        <div class="col-span-full card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">No external API connections yet.</div></div>
      {:else}
        {#each connections as c (c.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4 gap-2">
              <div class="flex items-start justify-between">
                <div class="font-medium text-sm">{c.name}</div>
                <span class="badge badge-ghost badge-sm">{c.auth_type}</span>
              </div>
              <div class="text-xs text-base-content/60 font-mono break-all">{c.base_url}</div>
              <div class="flex justify-end"><button class="btn btn-ghost btn-xs text-error" onclick={() => deleteConnection(c.id)}>Delete</button></div>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {:else if tab === 'webhooks'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Name</th><th>URL</th><th>Created</th><th>Last received</th></tr></thead>
        <tbody>
          {#if webhooks.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">No incoming webhook endpoints.</td></tr>
          {:else}{#each webhooks as w (w.id)}
            <tr class="hover"><td class="text-sm">{w.name}</td><td><code class="font-mono text-xs">{ENGINE_URL}/api/webhook/{w.slug}</code></td><td class="text-xs">{w.created_at?.slice(0, 10)}</td><td class="text-xs">{w.last_received_at?.slice(0, 16).replace('T', ' ') ?? 'never'}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Time</th><th>Connection</th><th>Method</th><th>URL</th><th>Status</th><th>Duration</th></tr></thead>
        <tbody>
          {#if logs.length === 0}<tr><td colspan="6" class="text-center py-6 text-base-content/50 text-sm">No call logs.</td></tr>
          {:else}{#each logs as l (l.id)}
            <tr class="hover">
              <td class="text-xs">{l.created_at?.slice(0, 19).replace('T', ' ')}</td>
              <td class="text-sm">{l.connection_name ?? '—'}</td>
              <td><span class="badge badge-ghost badge-sm">{l.method}</span></td>
              <td class="font-mono text-xs max-w-xs truncate">{l.url}</td>
              <td><span class="badge badge-sm {l.status_code < 400 ? 'badge-success' : 'badge-error'}">{l.status_code}</span></td>
              <td class="text-xs">{l.duration_ms ?? '—'} ms</td>
            </tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-lg">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">New API connection</h3><button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Name *</span></label><input class="input input-sm" bind:value={form.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Base URL *</span></label><input class="input input-sm font-mono" bind:value={form.base_url} placeholder="https://api.example.com" /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Auth</span></label>
          <select class="select select-sm" bind:value={form.auth_type}>
            <option value="none">None</option><option value="bearer">Bearer token</option><option value="basic">Basic auth</option><option value="oauth2">OAuth 2.0</option>
          </select>
        </div>
        {#if form.auth_type === 'bearer'}
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Token</span></label><input type="password" class="input input-sm font-mono" bind:value={form.auth_token} /></div>
        {:else if form.auth_type === 'basic'}
          <div class="grid grid-cols-2 gap-3">
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Username</span></label><input class="input input-sm" bind:value={form.auth_username} /></div>
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Password</span></label><input type="password" class="input input-sm" bind:value={form.auth_password} /></div>
          </div>
        {/if}
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Extra headers (JSON)</span></label><textarea class="textarea textarea-sm font-mono text-xs" rows="4" bind:value={form.headers}></textarea></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.name || !form.base_url} onclick={createConnection}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
  </div>
{/if}
