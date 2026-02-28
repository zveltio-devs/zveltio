<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { RefreshCw, Plus, Plug, Trash2, ExternalLink } from '@lucide/svelte';

  interface VirtualCollection {
    name: string;
    display_name: string;
    source_type: 'virtual';
    virtual_config: {
      source_url: string;
      auth_type: 'none' | 'bearer' | 'api_key' | 'basic';
      auth_value?: string;
      field_mapping: Record<string, string>;
      list_path: string;
      id_field: string;
    };
  }

  let collections = $state<VirtualCollection[]>([]);
  let loading = $state(true);
  let error = $state('');
  let showCreate = $state(false);
  let testResult = $state<{ ok: boolean; message: string; sample?: any } | null>(null);
  let testing = $state(false);

  // Create form state
  let form = $state({
    name: '',
    displayName: '',
    source_url: '',
    auth_type: 'none' as 'none' | 'bearer' | 'api_key' | 'basic',
    auth_value: '',
    list_path: '$.data',
    id_field: 'id',
    field_mapping_raw: '',
  });

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await api.get('/api/collections');
      collections = (res.collections || []).filter(
        (c: any) => c.source_type === 'virtual',
      );
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function testConnection() {
    testing = true;
    testResult = null;
    try {
      const res = await api.post('/api/data/' + (form.name || '_test_'), {});
      testResult = { ok: true, message: 'Connection OK', sample: res };
    } catch {
      // Try a GET instead
      try {
        const url = new URL(form.source_url);
        const headers: Record<string, string> = {};
        if (form.auth_type === 'bearer' && form.auth_value)
          headers['Authorization'] = `Bearer ${form.auth_value}`;
        if (form.auth_type === 'api_key' && form.auth_value)
          headers['X-API-Key'] = form.auth_value;
        const resp = await fetch(url.toString(), { headers });
        if (resp.ok) {
          const json = await resp.json();
          testResult = { ok: true, message: `Connected — status ${resp.status}`, sample: json };
        } else {
          testResult = { ok: false, message: `Source returned ${resp.status}` };
        }
      } catch (e2: any) {
        testResult = { ok: false, message: e2.message };
      }
    } finally {
      testing = false;
    }
  }

  function parseFieldMapping(): Record<string, string> {
    const mapping: Record<string, string> = {};
    for (const line of form.field_mapping_raw.split('\n')) {
      const parts = line.trim().split('=');
      if (parts.length === 2) {
        const [zveltio, external] = parts.map((s) => s.trim());
        if (zveltio && external) mapping[zveltio] = external;
      }
    }
    return mapping;
  }

  async function create() {
    if (!form.name || !form.source_url) return;
    try {
      await api.post('/api/collections', {
        name: form.name,
        displayName: form.displayName || form.name,
        source_type: 'virtual',
        fields: [{ name: 'id', type: 'uuid', required: true }], // placeholder
        virtual_config: {
          source_url: form.source_url,
          auth_type: form.auth_type,
          auth_value: form.auth_value || undefined,
          list_path: form.list_path || '$.data',
          id_field: form.id_field || 'id',
          field_mapping: parseFieldMapping(),
        },
      });
      showCreate = false;
      form = {
        name: '',
        displayName: '',
        source_url: '',
        auth_type: 'none',
        auth_value: '',
        list_path: '$.data',
        id_field: 'id',
        field_mapping_raw: '',
      };
      await load();
    } catch (e: any) {
      error = e.message;
    }
  }

  onMount(load);
</script>

<div class="p-6 max-w-4xl mx-auto">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-3xl font-bold flex items-center gap-2">
        <Plug size={28} class="text-primary" />
        Virtual Collections
      </h1>
      <p class="text-base-content/60 mt-1">
        Proxy external APIs (Stripe, Shopify, ERPs) as Zveltio collections.
      </p>
    </div>
    <div class="flex gap-2">
      <button class="btn btn-ghost btn-sm" onclick={load}>
        <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
      </button>
      <button class="btn btn-primary btn-sm" onclick={() => (showCreate = true)}>
        <Plus size={14} /> New Virtual Collection
      </button>
    </div>
  </div>

  {#if error}
    <div class="alert alert-error mb-4">{error}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-20">
      <span class="loading loading-spinner loading-lg text-primary"></span>
    </div>
  {:else if collections.length === 0}
    <div class="card bg-base-200 text-center py-16">
      <Plug size={40} class="mx-auto mb-4 text-base-content/30" />
      <p class="text-base-content/50 text-lg">No virtual collections yet.</p>
      <p class="text-base-content/40 text-sm mt-1">
        Connect external APIs and browse their data from Studio.
      </p>
    </div>
  {:else}
    <div class="grid gap-4">
      {#each collections as col}
        <div class="card bg-base-200 p-4">
          <div class="flex items-center justify-between">
            <div>
              <div class="font-semibold text-lg">{col.display_name || col.name}</div>
              <div class="text-sm text-base-content/50 font-mono">{col.virtual_config?.source_url}</div>
              <div class="flex gap-2 mt-1">
                <span class="badge badge-outline badge-sm">{col.virtual_config?.auth_type}</span>
                <span class="badge badge-outline badge-sm">{col.name}</span>
              </div>
            </div>
            <div class="flex gap-2">
              <a
                href="/admin/collections/{col.name}/data"
                class="btn btn-ghost btn-sm"
                title="Browse data"
              >
                <ExternalLink size={14} />
              </a>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Create modal -->
{#if showCreate}
  <div class="modal modal-open">
    <div class="modal-box w-11/12 max-w-2xl">
      <h3 class="font-bold text-lg mb-4">New Virtual Collection</h3>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="form-control">
          <label class="label"><span class="label-text">Collection name *</span></label>
          <input
            class="input input-bordered input-sm"
            placeholder="stripe_customers"
            bind:value={form.name}
          />
          <label class="label"><span class="label-text-alt">lowercase, no spaces</span></label>
        </div>
        <div class="form-control">
          <label class="label"><span class="label-text">Display name</span></label>
          <input
            class="input input-bordered input-sm"
            placeholder="Stripe Customers"
            bind:value={form.displayName}
          />
        </div>
      </div>

      <div class="form-control mb-4">
        <label class="label"><span class="label-text">Source URL *</span></label>
        <input
          class="input input-bordered input-sm font-mono"
          placeholder="https://api.stripe.com/v1/customers"
          bind:value={form.source_url}
        />
      </div>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="form-control">
          <label class="label"><span class="label-text">Auth type</span></label>
          <select class="select select-bordered select-sm" bind:value={form.auth_type}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="api_key">API Key header</option>
            <option value="basic">Basic auth</option>
          </select>
        </div>
        {#if form.auth_type !== 'none'}
          <div class="form-control">
            <label class="label"><span class="label-text">Auth value</span></label>
            <input
              class="input input-bordered input-sm"
              type="password"
              placeholder={form.auth_type === 'basic' ? 'user:password' : 'token'}
              bind:value={form.auth_value}
            />
          </div>
        {/if}
      </div>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="form-control">
          <label class="label"><span class="label-text">Items path in response</span></label>
          <input
            class="input input-bordered input-sm font-mono"
            placeholder="$.data"
            bind:value={form.list_path}
          />
          <label class="label"><span class="label-text-alt">e.g. $.data, $.results, $.items</span></label>
        </div>
        <div class="form-control">
          <label class="label"><span class="label-text">ID field</span></label>
          <input
            class="input input-bordered input-sm font-mono"
            placeholder="id"
            bind:value={form.id_field}
          />
        </div>
      </div>

      <div class="form-control mb-4">
        <label class="label">
          <span class="label-text">Field mapping (optional)</span>
          <span class="label-text-alt">zveltio_field=external_field, one per line</span>
        </label>
        <textarea
          class="textarea textarea-bordered textarea-sm font-mono text-xs"
          rows={4}
          placeholder={"customer_id=id\ncustomer_name=name\nemail=email_address"}
          bind:value={form.field_mapping_raw}
        ></textarea>
      </div>

      {#if testResult}
        <div class="alert {testResult.ok ? 'alert-success' : 'alert-error'} mb-4 text-sm">
          {testResult.message}
        </div>
      {/if}

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showCreate = false)}>Cancel</button>
        <button class="btn btn-outline btn-sm" onclick={testConnection} disabled={!form.source_url || testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button class="btn btn-primary btn-sm" onclick={create} disabled={!form.name || !form.source_url}>
          Create
        </button>
      </div>
    </div>
    <div class="modal-backdrop" onclick={() => (showCreate = false)}></div>
  </div>
{/if}
