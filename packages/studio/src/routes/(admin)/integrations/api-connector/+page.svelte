<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { ENGINE_URL } from '$lib/config.js';
import { Plug, Plus, X, Webhook, ListChecks, LoaderCircle } from '@lucide/svelte';

const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

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
  try {
    const r = await api.get<{ data: any[] }>('/ext/integrations/api-connector/connections');
    connections = r.data ?? [];
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}
async function loadWebhooks() {
  loading = true;
  try {
    const r = await api.get<{ data: any[] }>('/ext/integrations/api-connector/incoming-webhooks');
    webhooks = r.data ?? [];
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}
async function loadLogs() {
  loading = true;
  try {
    const r = await api.get<{ data: any[] }>('/ext/integrations/api-connector/logs?limit=100');
    logs = r.data ?? [];
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}

async function createConnection() {
  saving = true;
  try {
    let extraHeaders: any = {};
    try {
      extraHeaders = JSON.parse(form.headers);
    } catch {
      throw new Error('Invalid JSON in headers');
    }
    await api.post('/ext/integrations/api-connector/connections', {
      ...form,
      headers: extraHeaders,
    });
    showForm = false;
    form = {
      name: '',
      base_url: '',
      auth_type: 'none',
      auth_token: '',
      auth_username: '',
      auth_password: '',
      headers: '{}',
    };
    await loadConnections();
    toast.success(m['integrations.apiConnector.toast.created']());
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  } finally {
    saving = false;
  }
}

async function deleteConnection(id: string) {
  askConfirm(m['integrations.apiConnector.confirmDelete'](), () => deleteConnectionConfirmed(id));
}
async function deleteConnectionConfirmed(id: string) {
  try {
    await api.delete(`/ext/integrations/api-connector/connections/${id}`);
    await loadConnections();
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}

$effect(() => {
  if (tab === 'connections') loadConnections();
  else if (tab === 'webhooks') loadWebhooks();
  else loadLogs();
});
onMount(loadConnections);
</script>

<ExtensionPageShell title={m['integrations.api-connector.title']()} subtitle={m['integrations.api-connector.subtitle']()}>
    {#snippet actions()}
    {#if tab === 'connections'}<button class="btn btn-primary btn-sm gap-1" onclick={() => (showForm = true)}><Plus size={14} /> {m['integrations.api-connector.btn.new']()}</button>{/if}
  {/snippet}

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'connections' ? 'tab-active' : ''}" onclick={() => (tab = 'connections')}><Plug size={13} class="mr-1.5" /> {m['integrations.api-connector.tab.connections']()}</button>
    <button class="tab {tab === 'webhooks' ? 'tab-active' : ''}" onclick={() => (tab = 'webhooks')}><Webhook size={13} class="mr-1.5" /> {m['integrations.api-connector.tab.webhooks']()}</button>
    <button class="tab {tab === 'logs' ? 'tab-active' : ''}" onclick={() => (tab = 'logs')}><ListChecks size={13} class="mr-1.5" /> {m['integrations.api-connector.tab.logs']()}</button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'connections'}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {#if connections.length === 0}
        <div class="col-span-full card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">{m['integrations.api-connector.empty.connections']()}</div></div>
      {:else}
        {#each connections as c (c.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-4 gap-2">
              <div class="flex items-start justify-between">
                <div class="font-medium text-sm">{c.name}</div>
                <span class="badge badge-ghost badge-sm">{c.auth_type}</span>
              </div>
              <div class="text-xs text-base-content/60 font-mono break-all">{c.base_url}</div>
              <div class="flex justify-end"><button class="btn btn-ghost btn-xs text-error" onclick={() => deleteConnection(c.id)}>{m['common.delete']()}</button></div>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {:else if tab === 'webhooks'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.name']()}</th><th>{m['integrations.api-connector.col.url']()}</th><th>{m['common.col.created']()}</th><th>{m['integrations.api-connector.col.lastReceived']()}</th></tr></thead>
        <tbody>
          {#if webhooks.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['integrations.api-connector.ui.no_incoming_webhook_endpoints']()}</td></tr>
          {:else}{#each webhooks as w (w.id)}
            <tr class="hover"><td class="text-sm">{w.name}</td><td><code class="font-mono text-xs">{ENGINE_URL}/api/webhook/{w.slug}</code></td><td class="text-xs">{w.created_at?.slice(0, 10)}</td><td class="text-xs">{w.last_received_at?.slice(0, 16).replace('T', ' ') ?? 'never'}</td></tr>
          {/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['integrations.api-connector.col.time']()}</th><th>{m['integrations.api-connector.col.connection']()}</th><th>{m['common.col.method']()}</th><th>{m['integrations.api-connector.col.url']()}</th><th>{m['common.col.status']()}</th><th>{m['common.col.duration']()}</th></tr></thead>
        <tbody>
          {#if logs.length === 0}<tr><td colspan="6" class="text-center py-6 text-base-content/50 text-sm">{m['integrations.api-connector.ui.no_call_logs']()}</td></tr>
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

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel}
  confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction}
  oncancel={cancelConfirm}
/>

</ExtensionPageShell>

{#if showForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-lg">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">{m['integrations.api-connector.ui.new_api_connection']()}</h3><button class="btn btn-ghost btn-xs" onclick={() => (showForm = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['content.document-templates.ui.name']()}</span></label><input class="input input-sm" bind:value={form.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['integrations.api-connector.ui.base_url']()}</span></label><input class="input input-sm font-mono" bind:value={form.base_url} placeholder={m['integrations.api-connector.ui.https_api_example_com']()} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['integrations.api-connector.ui.auth']()}</span></label>
          <select class="select select-sm" bind:value={form.auth_type}>
            <option value="none">{m['integrations.api-connector.ui.none']()}</option><option value="bearer">{m['integrations.api-connector.ui.bearer_token']()}</option><option value="basic">{m['integrations.api-connector.ui.basic_auth']()}</option><option value="oauth2">{m['integrations.api-connector.ui.oauth_2_0']()}</option>
          </select>
        </div>
        {#if form.auth_type === 'bearer'}
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['integrations.api-connector.ui.token']()}</span></label><input type="password" class="input input-sm font-mono" bind:value={form.auth_token} /></div>
        {:else if form.auth_type === 'basic'}
          <div class="grid grid-cols-2 gap-3">
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['integrations.api-connector.ui.username']()}</span></label><input class="input input-sm" bind:value={form.auth_username} /></div>
            <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['auth.password']()}</span></label><input type="password" class="input input-sm" bind:value={form.auth_password} /></div>
          </div>
        {/if}
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['integrations.api-connector.ui.extra_headers_json']()}</span></label><textarea class="textarea textarea-sm font-mono text-xs" rows="4" bind:value={form.headers}></textarea></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !form.name || !form.base_url} onclick={createConnection}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} {m['integrations.api-connector.btn.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}
