<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Plus, Key, Trash2, Copy, Check, LoaderCircle } from '@lucide/svelte';

  interface ApiKey {
    id: string;
    name: string;
    key_prefix: string;
    scopes: Array<{ collection: string; actions: string[] }>;
    created_at: string;
    last_used_at: string | null;
    expires_at: string | null;
    is_active: boolean;
    rate_limit: number;
  }

  let apiKeys = $state<ApiKey[]>([]);
  let loading = $state(true);
  let showCreateModal = $state(false);
  let creating = $state(false);
  let newlyCreatedKey = $state<string | null>(null);
  let copied = $state(false);
  let error = $state('');

  const ALL_ACTIONS = ['read', 'write', 'delete'];

  const emptyForm = () => ({
    name: '',
    rate_limit: 1000,
    expires_at: '',
    scopes: [{ collection: '*', actions: ['read', 'write', 'delete'] as string[] }],
  });
  let form = $state(emptyForm());

  onMount(() => loadKeys());

  async function loadKeys() {
    loading = true;
    error = '';
    try {
      const res = await api.get<{ api_keys: ApiKey[] }>('/api/api-keys');
      apiKeys = res.api_keys || [];
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function createKey() {
    if (!form.name.trim()) return;
    creating = true;
    try {
      const res = await api.post<{ id: string; key: string; key_prefix: string }>('/api/api-keys', {
        name: form.name.trim(),
        rate_limit: form.rate_limit,
        expires_at: form.expires_at || undefined,
        scopes: form.scopes,
      });
      newlyCreatedKey = res.key || null;
      showCreateModal = false;
      form = emptyForm();
      await loadKeys();
    } catch (e: any) {
      alert(e.message || 'Failed to create key');
    } finally {
      creating = false;
    }
  }

  async function revokeKey(id: string) {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    try {
      await api.delete(`/api/api-keys/${id}`);
      await loadKeys();
    } catch (e: any) {
      alert(e.message || 'Failed to revoke key');
    }
  }

  async function copyKey() {
    if (!newlyCreatedKey) return;
    await navigator.clipboard.writeText(newlyCreatedKey);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function formatExpiry(date: string | null): string {
    if (!date) return 'Never';
    const d = new Date(date);
    return d < new Date() ? `Expired ${d.toLocaleDateString()}` : d.toLocaleDateString();
  }

  function addScope() {
    form.scopes = [...form.scopes, { collection: '', actions: ['read'] }];
  }

  function removeScope(i: number) {
    form.scopes = form.scopes.filter((_, idx) => idx !== i);
  }

  function toggleAction(scopeIdx: number, action: string) {
    const scope = form.scopes[scopeIdx];
    const actions = scope.actions.includes(action)
      ? scope.actions.filter(a => a !== action)
      : [...scope.actions, action];
    form.scopes = form.scopes.map((s, i) => i === scopeIdx ? { ...s, actions } : s);
  }

  function scopesSummary(scopes: Array<{ collection: string; actions: string[] }>): string {
    if (!scopes || scopes.length === 0) return 'No scopes';
    if (scopes.length === 1 && scopes[0].collection === '*') return 'All collections';
    return scopes.map(s => s.collection || '?').join(', ');
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">API Keys</h1>
      <p class="text-base-content/60 text-sm mt-1">Manage programmatic access to the Zveltio API</p>
    </div>
    <button class="btn btn-primary btn-sm gap-2" onclick={() => (showCreateModal = true)}>
      <Plus size={16} /> Create Key
    </button>
  </div>

  {#if error}
    <div class="alert alert-error text-sm">{error}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-16">
      <LoaderCircle size={32} class="animate-spin text-primary" />
    </div>
  {:else if apiKeys.length === 0}
    <div class="card bg-base-200 text-center py-16">
      <Key size={40} class="mx-auto text-base-content/30 mb-3" />
      <p class="text-base-content/60">No API keys yet. Create one to get started.</p>
      <button class="btn btn-primary btn-sm mt-4" onclick={() => (showCreateModal = true)}>
        <Plus size={14} /> Create First Key
      </button>
    </div>
  {:else}
    <div class="card bg-base-200">
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key Prefix</th>
              <th>Scopes</th>
              <th>Rate Limit</th>
              <th>Expires</th>
              <th>Last Used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each apiKeys as key}
              <tr class="{!key.is_active ? 'opacity-50' : ''}">
                <td class="font-medium">{key.name}</td>
                <td><code class="text-xs bg-base-300 px-2 py-1 rounded">{key.key_prefix}…</code></td>
                <td class="text-sm text-base-content/70">{scopesSummary(key.scopes)}</td>
                <td class="text-sm">{key.rate_limit}/hr</td>
                <td class="text-sm">{formatExpiry(key.expires_at)}</td>
                <td class="text-sm text-base-content/60">
                  {key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : 'Never'}
                </td>
                <td>
                  <span class="badge badge-sm {key.is_active ? 'badge-success' : 'badge-error'}">
                    {key.is_active ? 'Active' : 'Revoked'}
                  </span>
                </td>
                <td>
                  {#if key.is_active}
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => revokeKey(key.id)} title="Revoke">
                      <Trash2 size={14} />
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

<!-- Create modal -->
{#if showCreateModal}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-lg">
      <h3 class="font-bold text-lg mb-4">Create API Key</h3>
      <div class="space-y-4">
        <div class="form-control">
          <label class="label" for="api-key-name"><span class="label-text">Key name *</span></label>
          <input id="api-key-name" type="text" bind:value={form.name} placeholder="Production API Key" class="input" />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div class="form-control">
            <label class="label" for="api-key-rate-limit"><span class="label-text">Rate limit (req/hour)</span></label>
            <input id="api-key-rate-limit" type="number" bind:value={form.rate_limit} min="1" class="input" />
          </div>
          <div class="form-control">
            <label class="label">
              <span class="label-text">Expiry date</span>
              <span class="label-text-alt">Optional</span>
            </label>
            <input type="date" bind:value={form.expires_at} class="input" />
          </div>
        </div>

        <!-- Scopes -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="label-text font-medium">Scopes</span>
            <button class="btn btn-xs btn-ghost gap-1" onclick={addScope}><Plus size={12} /> Add scope</button>
          </div>
          <div class="space-y-2">
            {#each form.scopes as scope, i}
              <div class="flex items-center gap-2 p-2 bg-base-300 rounded-lg">
                <input
                  class="input input-xs flex-1"
                  type="text"
                  placeholder="collection or *"
                  bind:value={scope.collection}
                />
                <div class="flex gap-1">
                  {#each ALL_ACTIONS as action}
                    <label class="flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        class="checkbox checkbox-xs"
                        checked={scope.actions.includes(action)}
                        onchange={() => toggleAction(i, action)}
                      />
                      <span class="text-xs">{action}</span>
                    </label>
                  {/each}
                </div>
                {#if form.scopes.length > 1}
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => removeScope(i)}>✕</button>
                {/if}
              </div>
            {/each}
          </div>
        </div>

        <div class="alert alert-info text-sm py-2">
          <Key size={16} />
          <span>The full key will only be shown once immediately after creation. Store it securely.</span>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createKey} disabled={creating || !form.name.trim()}>
          {#if creating}<LoaderCircle size={16} class="animate-spin" />{/if}
          Create
        </button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => (showCreateModal = false)}></button>
  </dialog>
{/if}

<!-- Newly created key display -->
{#if newlyCreatedKey}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-2">API Key Created</h3>
      <p class="text-sm text-base-content/70 mb-4">Copy this key now — it won't be shown again.</p>
      <div class="flex items-center gap-2">
        <code class="flex-1 bg-base-300 px-3 py-2 rounded text-sm font-mono break-all">{newlyCreatedKey}</code>
        <button class="btn btn-square btn-sm" onclick={copyKey} title="Copy to clipboard">
          {#if copied}<Check size={16} class="text-success" />{:else}<Copy size={16} />{/if}
        </button>
      </div>
      <div class="modal-action">
        <button class="btn btn-primary" onclick={() => { newlyCreatedKey = null; }}>Done</button>
      </div>
    </div>
  </dialog>
{/if}
