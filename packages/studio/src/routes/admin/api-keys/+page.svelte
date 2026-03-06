<script lang="ts">
 import { onMount } from 'svelte';
 import { Plus, Key, Trash2, Copy, Check, Eye, EyeOff } from '@lucide/svelte';

 const engineUrl = import.meta.env.PUBLIC_ENGINE_URL || '';

 let apiKeys = $state<any[]>([]);
 let loading = $state(true);
 let showCreateModal = $state(false);
 let creating = $state(false);
 let newlyCreatedKey = $state<string | null>(null);
 let copied = $state(false);

 let form = $state({
 name: '',
 rate_limit: 1000,
 expires_at: '',
 scopes: [{ collection: '*', actions: ['read', 'write', 'delete'] }],
 });

 onMount(() => loadKeys());

 async function loadKeys() {
 loading = true;
 const res = await fetch(`${engineUrl}/api/admin/api-keys`, { credentials: 'include' }).then((r) => r.json());
 apiKeys = res.api_keys || [];
 loading = false;
 }

 async function createKey() {
 if (!form.name.trim()) return;
 creating = true;
 try {
 const res = await fetch(`${engineUrl}/api/admin/api-keys`, {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 name: form.name,
 rate_limit: form.rate_limit,
 expires_at: form.expires_at || undefined,
 scopes: form.scopes,
 }),
 }).then((r) => r.json());

 newlyCreatedKey = res.api_key?.key || null;
 await loadKeys();
 form = { name: '', rate_limit: 1000, expires_at: '', scopes: [{ collection: '*', actions: ['read', 'write', 'delete'] }] };
 } finally {
 creating = false;
 }
 }

 async function revokeKey(id: string) {
 if (!confirm('Revoke this API key? This cannot be undone.')) return;
 await fetch(`${engineUrl}/api/admin/api-keys/${id}`, { method: 'DELETE', credentials: 'include' });
 await loadKeys();
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
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">API Keys</h1>
 <p class="text-base-content/60 text-sm mt-1">Manage programmatic access to the Zveltio API</p>
 </div>
 <button class="btn btn-primary btn-sm gap-2" onclick={() => (showCreateModal = true)}>
 <Plus size={16} />Create Key
 </button>
 </div>

 {#if loading}
 <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
 {:else if apiKeys.length === 0}
 <div class="card bg-base-200 text-center py-16">
 <Key size={40} class="mx-auto text-base-content/30 mb-3" />
 <p class="text-base-content/60">No API keys yet. Create one to get started.</p>
 </div>
 {:else}
 <div class="card bg-base-200">
 <div class="overflow-x-auto">
 <table class="table">
 <thead>
 <tr>
 <th>Name</th>
 <th>Key Prefix</th>
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
 <button class="btn btn-ghost btn-xs text-error" onclick={() => revokeKey(key.id)}>
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
 <div class="modal-box">
 <h3 class="font-bold text-lg mb-4">Create API Key</h3>
 <div class="space-y-4">
 <div class="form-control">
 <label class="label"><span class="label-text">Key name</span></label>
 <input type="text" bind:value={form.name} placeholder="Production API Key" class="input" />
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text">Rate limit (requests/hour)</span></label>
 <input type="number" bind:value={form.rate_limit} min="1" class="input" />
 </div>
 <div class="form-control">
 <label class="label">
 <span class="label-text">Expiry date</span>
 <span class="label-text-alt">Leave empty for no expiry</span>
 </label>
 <input type="date" bind:value={form.expires_at} class="input" />
 </div>
 <div class="alert alert-info text-sm">
 <Key size={16} />
 <span>The full key will only be shown once immediately after creation. Store it securely.</span>
 </div>
 </div>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
 <button class="btn btn-primary" onclick={createKey} disabled={creating}>
 {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
 Create
 </button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
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
 <button class="btn btn-square btn-sm" onclick={copyKey}>
 {#if copied}<Check size={16} class="text-success" />{:else}<Copy size={16} />{/if}
 </button>
 </div>
 <div class="modal-action">
 <button class="btn btn-primary" onclick={() => { newlyCreatedKey = null; showCreateModal = false; }}>Done</button>
 </div>
 </div>
 </dialog>
{/if}
