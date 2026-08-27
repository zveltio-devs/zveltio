<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import { fmtDate } from '$lib/stores/format.svelte.js';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { Key, Trash2, Copy, Check, LoaderCircle, Plus } from '@lucide/svelte';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import Modal from '$lib/components/common/Modal.svelte';
import Pagination from '$lib/components/common/Pagination.svelte';
import CrudListPage from '$lib/components/common/CrudListPage.svelte';
import { toast } from '$lib/stores/toast.svelte.js';

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
let currentPage = $state(1);
let total = $state(0);
const LIMIT = 20;
let showCreateModal = $state(false);
let confirmState = $state<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onconfirm: () => void;
}>({ open: false, title: '', message: '', onconfirm: () => {} });
let creating = $state(false);
let newlyCreatedKey = $state<string | null>(null);
let copied = $state(false);

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
  try {
    const res = await api.get<{ api_keys: ApiKey[]; total?: number }>(
      `/api/api-keys?limit=${LIMIT}&offset=${(currentPage - 1) * LIMIT}`,
    );
    apiKeys = res.api_keys || [];
    total = res.total ?? apiKeys.length;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e.message ?? 'Something went wrong');
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e.message || 'Failed to create key');
  } finally {
    creating = false;
  }
}

async function revokeKey(id: string) {
  confirmState = {
    open: true,
    title: 'Revoke API Key',
    message: 'Revoke this API key? This cannot be undone.',
    confirmLabel: 'Revoke',
    onconfirm: async () => {
      confirmState.open = false;
      try {
        await api.delete(`/api/api-keys/${id}`);
        await loadKeys();
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      } catch (e: any) {
        toast.error(e.message || 'Failed to revoke key');
      }
    },
  };
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
  return d < new Date() ? `Expired ${fmtDate(d)}` : fmtDate(d);
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
    ? scope.actions.filter((a) => a !== action)
    : [...scope.actions, action];
  form.scopes = form.scopes.map((s, i) => (i === scopeIdx ? { ...s, actions } : s));
}

function scopesSummary(scopes: Array<{ collection: string; actions: string[] }>): string {
  if (!scopes || scopes.length === 0) return 'No scopes';
  if (scopes.length === 1 && scopes[0].collection === '*') return 'All collections';
  return scopes.map((s) => s.collection || '?').join(', ');
}

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
</script>

<CrudListPage
  title={m['nav.apiKeys']()}
  subtitle={m['apiKeys.subtitle']()}
  count={apiKeys.length}
  {loading}
  actionLabel="Create Key"
  onAction={() => (showCreateModal = true)}
  empty={{
    illustration: 'target',
    illustrationColor: 'text-secondary',
    title: 'Generate your first key',
    description: 'API keys give SDKs, automations, or external services scoped access to the engine. Each key can have a different permission scope.',
    actionLabel: 'Create key',
    onAction: () => (showCreateModal = true),
  }}
>
  {#snippet list()}
    <div class="card bg-base-100">
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>{m['common.col.name']()}</th>
              <th>{m['apiKeys.keyPrefix']()}</th>
              <th>{m['apiKeys.scopes']()}</th>
              <th>{m['apiKeys.rateLimit']()}</th>
              <th>{m['apiKeys.expires']()}</th>
              <th>{m['apiKeys.lastUsed']()}</th>
              <th>{m['common.col.status']()}</th>
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
                <td class="text-sm text-base-content/65">
                  {key.last_used_at ? formatRelative(key.last_used_at) : 'Never'}
                </td>
                <td>
                  <span class="badge badge-sm {key.is_active ? 'badge-success' : 'badge-error'}">
                    {key.is_active ? 'Active' : 'Revoked'}
                  </span>
                </td>
                <td>
                  {#if key.is_active}
                    <button type="button" class="btn btn-ghost btn-xs text-error" onclick={() => revokeKey(key.id)} title={m['apiKeys.revoke']()}>
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
  {/snippet}

  {#snippet pagination()}
    <Pagination {total} page={currentPage} limit={LIMIT} onchange={(p) => { currentPage = p; loadKeys(); }} />
  {/snippet}
</CrudListPage>

<!-- Create modal -->
{#if showCreateModal}
  <Modal bind:open={showCreateModal} title={m['apiKeys.create']()} size="md" onSubmit={createKey}>
      <div class="space-y-4">
        <div class="form-control">
          <label class="label" for="api-key-name"><span class="label-text">{m['apiKeys.nameLabel']()}</span></label>
          <input id="api-key-name" type="text" bind:value={form.name} placeholder={m['apiKeys.namePlaceholder']()} class="input" />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div class="form-control">
            <label class="label" for="api-key-rate-limit"><span class="label-text">{m['apiKeys.rateLimitLabel']()}</span></label>
            <input id="api-key-rate-limit" type="number" bind:value={form.rate_limit} min="1" class="input" />
          </div>
          <div class="form-control">
            <div class="label">
              <span class="label-text">{m['apiKeys.expiryDate']()}</span>
              <span class="label-text-alt">{m['common.optional']()}</span>
            </div>
            <input type="date" bind:value={form.expires_at} class="input" />
          </div>
        </div>

        <!-- Scopes -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="label-text font-medium">{m['apiKeys.scopes']()}</span>
            <button type="button" class="btn btn-xs btn-ghost gap-1" onclick={addScope}><Plus size={12} /> {m['apiKeys.addScope']()}</button>
          </div>
          <div class="space-y-2">
            {#each form.scopes as scope, i}
              <div class="flex items-center gap-2 p-2 bg-base-300 rounded-lg">
                <input
                  class="input input-xs flex-1"
                  type="text"
                  placeholder={m['apiKeys.scopePlaceholder']()}
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
                  <button type="button" class="btn btn-ghost btn-xs text-error" onclick={() => removeScope(i)}>✕</button>
                {/if}
              </div>
            {/each}
          </div>
        </div>

        <div class="alert alert-info text-sm py-2">
          <Key size={16} />
          <span>{m['apiKeys.shownOnce']()}</span>
        </div>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost" onclick={() => (showCreateModal = false)}>{m['common.cancel']()}</button>
        <button type="submit" class="btn btn-primary" disabled={creating || !form.name.trim()}>
          {#if creating}<LoaderCircle size={16} class="animate-spin" />{/if}
          Create
        </button>
      </div>
  </Modal>
{/if}

<!-- Newly created key display -->
{#if newlyCreatedKey}
  <!-- Not dismissible: the key is shown once and never again, so a stray Escape
       or backdrop click would lose it silently. The Done button is the only way
       out, which is what the original markup meant by having no backdrop. -->
  <Modal open={true} dismissible={false} title={m['apiKeys.created']()} size="md">
      <p class="text-sm text-base-content/70 mb-4">{m['apiKeys.copyNow']()}</p>
      <div class="flex items-center gap-2">
        <code class="flex-1 bg-base-300 px-3 py-2 rounded text-sm font-mono break-all">{newlyCreatedKey}</code>
        <button type="button" class="btn btn-square btn-sm" onclick={copyKey} title={m['common.copy']()}>
          {#if copied}<Check size={16} class="text-success" />{:else}<Copy size={16} />{/if}
        </button>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-primary" onclick={() => { newlyCreatedKey = null; }}>{m['common.done']()}</button>
      </div>
  </Modal>
{/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
