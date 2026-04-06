<script lang="ts">
 import { onMount } from 'svelte';
 import { webhooksApi, collectionsApi } from '$lib/api.js';
 import { Plus, Webhook, LoaderCircle } from '@lucide/svelte';
 import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
 import Pagination from '$lib/components/common/Pagination.svelte';
 import LoadingSkeleton from '$lib/components/common/LoadingSkeleton.svelte';
 import PageHeader from '$lib/components/common/PageHeader.svelte';
 import { toast } from '$lib/stores/toast.svelte.js';

 let webhooks = $state<any[]>([]);
 let collections = $state<any[]>([]);
 let loading = $state(true);
 let currentPage = $state(1);
 let total = $state(0);
 const LIMIT = 20;
 let showModal = $state(false);
 let editTarget = $state<any>(null);
 let saving = $state(false);
 let testing = $state<string | null>(null);
 let testResults = $state<Record<string, { ok: boolean; error?: string }>>({});
 let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

 const emptyForm = () => ({
 name: '', url: '', method: 'POST',
 events: [] as string[], collections: [] as string[],
 active: true, secret: '', retry_attempts: 3, timeout: 5000,
 });
 let form = $state(emptyForm());

 const ALL_EVENTS = [
 'data.create', 'data.update', 'data.delete',
 'collection.create', 'collection.delete',
 'user.login', 'user.logout',
 ];

 onMount(load);

 async function load() {
 loading = true;
 try {
 const [wh, col] = await Promise.all([webhooksApi.list(), collectionsApi.list()]);
 const allWebhooks: any[] = Array.isArray(wh) ? wh : (wh as any).webhooks ?? wh;
 total = (wh as any).total ?? allWebhooks.length;
 webhooks = allWebhooks.slice((currentPage - 1) * LIMIT, currentPage * LIMIT);
 collections = col.collections || [];
 } finally { loading = false; }
 }

 function openCreate() { editTarget = null; form = emptyForm(); showModal = true; }
 function openEdit(wh: any) {
 editTarget = wh;
 form = {
 name: wh.name, url: wh.url, method: wh.method || 'POST',
 events: [...(wh.events || [])], collections: [...(wh.collections || [])],
 active: wh.active ?? true, secret: wh.secret || '',
 retry_attempts: wh.retry_attempts ?? 3, timeout: wh.timeout ?? 5000,
 };
 showModal = true;
 }

 function toggleEvent(ev: string) {
 form.events = form.events.includes(ev)
 ? form.events.filter(e => e !== ev)
 : [...form.events, ev];
 }
 function toggleCollection(name: string) {
 form.collections = form.collections.includes(name)
 ? form.collections.filter(c => c !== name)
 : [...form.collections, name];
 }

 async function save() {
 if (!form.name || !form.url || form.events.length === 0) return;
 saving = true;
 try {
 const payload = { ...form, secret: form.secret || undefined };
 editTarget
 ? await webhooksApi.update(editTarget.id, payload)
 : await webhooksApi.create(payload);
 showModal = false;
 await load();
 } catch (err) {
 toast.error(err instanceof Error ? err.message : 'Save failed');
 } finally { saving = false; }
 }

 async function remove(id: string, name: string) {
 confirmState = {
 open: true,
 title: 'Delete Webhook',
 message: `Delete webhook "${name}"?`,
 confirmLabel: 'Delete',
 onconfirm: async () => {
 confirmState.open = false;
 await webhooksApi.delete(id);
 await load();
 },
 };
 }

 async function testWebhook(id: string) {
 testing = id;
 try {
 await webhooksApi.test(id);
 testResults = { ...testResults, [id]: { ok: true } };
 } catch (err) {
 testResults = { ...testResults, [id]: { ok: false, error: err instanceof Error ? err.message : 'Failed' } };
 } finally { testing = null; }
 }
</script>

<div class="space-y-6">
 <PageHeader title="Webhooks" subtitle="HTTP callbacks triggered by data events" count={total || undefined}>
   <button class="btn btn-primary btn-sm" onclick={openCreate}>
     <Plus size={16} /> New Webhook
   </button>
 </PageHeader>

 {#if loading}
 <LoadingSkeleton type="list" rows={5} />
 {:else if webhooks.length === 0}
 <div class="flex flex-col items-center justify-center py-20 text-base-content/40 gap-3">
 <Webhook size={48} class="opacity-20" />
 <p class="text-lg font-semibold text-base-content/60">No webhooks yet</p>
 <p class="text-sm text-center max-w-sm">Send HTTP callbacks to external services when events occur.</p>
 <button class="btn btn-primary btn-sm mt-2" onclick={openCreate}>Add Webhook</button>
 </div>
 {:else}
 <div class="card bg-base-100 shadow-sm overflow-x-auto">
 <table class="table table-sm w-full">
 <thead>
 <tr>
 <th>Name</th><th>URL</th><th>Events</th><th>Status</th><th class="text-right">Actions</th>
 </tr>
 </thead>
 <tbody>
 {#each webhooks as wh}
 <tr class="hover group">
 <td class="font-medium">{wh.name}</td>
 <td class="font-mono text-xs text-base-content/50 max-w-48 truncate">{wh.url}</td>
 <td>
 <div class="flex flex-wrap gap-1">
 {#each (wh.events || []).slice(0, 3) as ev}
 <span class="badge badge-ghost badge-xs">{ev}</span>
 {/each}
 {#if wh.events?.length > 3}
 <span class="badge badge-ghost badge-xs">+{wh.events.length - 3}</span>
 {/if}
 </div>
 {#if testResults[wh.id]}
 <p class="text-xs mt-1 {testResults[wh.id].ok ? 'text-success' : 'text-error'}">
 {testResults[wh.id].ok ? '✓ Delivered' : `✗ ${testResults[wh.id].error}`}
 </p>
 {/if}
 </td>
 <td>
 <span class="badge badge-sm {wh.active ? 'badge-success' : 'badge-ghost'}">
 {wh.active ? 'active' : 'paused'}
 </span>
 </td>
 <td class="text-right">
 <button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100" onclick={() => testWebhook(wh.id)} disabled={testing === wh.id}>
 {#if testing === wh.id}<LoaderCircle size={12} class="animate-spin" />{:else}Test{/if}
 </button>
 <button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100" onclick={() => openEdit(wh)}>Edit</button>
 <button class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100" onclick={() => remove(wh.id, wh.name)}>Del</button>
 </td>
 </tr>
 {/each}
 </tbody>
 </table>
 </div>
 {/if}
 <Pagination {total} page={currentPage} limit={LIMIT} onchange={(p) => { currentPage = p; load(); }} />
</div>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') showModal = false; }} />

{#if showModal}
 <dialog class="modal modal-open">
 <div class="modal-box w-11/12 max-w-2xl">
 <h3 class="font-bold text-lg mb-4">{editTarget ? 'Edit Webhook' : 'New Webhook'}</h3>
 <div class="space-y-4">
 <div class="form-control">
 <label class="label" for="webhook-name"><span class="label-text">Name *</span></label>
 <input id="webhook-name" class="input" bind:value={form.name} placeholder="My Webhook" />
 </div>
 <div class="form-control">
 <label class="label" for="webhook-url"><span class="label-text">URL *</span></label>
 <input id="webhook-url" class="input font-mono" bind:value={form.url} placeholder="https://example.com/webhook" />
 </div>
 <div class="grid grid-cols-2 gap-4">
 <div class="form-control">
 <label class="label" for="webhook-method"><span class="label-text">Method</span></label>
 <select id="webhook-method" class="select" bind:value={form.method}>
 <option>POST</option><option>PUT</option><option>PATCH</option>
 </select>
 </div>
 <div class="form-control">
 <label class="label" for="webhook-secret"><span class="label-text">Secret (optional)</span></label>
 <input id="webhook-secret" class="input font-mono" bind:value={form.secret} placeholder="Signing secret" />
 </div>
 </div>
 <div class="grid grid-cols-2 gap-4">
 <div class="form-control">
 <label class="label" for="webhook-retry"><span class="label-text">Retry attempts</span></label>
 <input id="webhook-retry" type="number" class="input" bind:value={form.retry_attempts} min="0" max="10" />
 </div>
 <div class="form-control">
 <label class="label" for="webhook-timeout"><span class="label-text">Timeout (ms)</span></label>
 <input id="webhook-timeout" type="number" class="input" bind:value={form.timeout} min="1000" max="30000" step="500" />
 </div>
 </div>
 <div class="form-control">
 <p class="label"><span class="label-text">Events * (select at least one)</span></p>
 <div class="flex flex-wrap gap-2 p-3 border border-base-300 rounded-lg">
 {#each ALL_EVENTS as ev}
 <label class="flex items-center gap-1.5 cursor-pointer">
 <input type="checkbox" class="checkbox checkbox-xs" checked={form.events.includes(ev)} onchange={() => toggleEvent(ev)} />
 <span class="text-sm font-mono">{ev}</span>
 </label>
 {/each}
 </div>
 </div>
 {#if collections.length > 0}
 <div class="form-control">
 <p class="label"><span class="label-text">Restrict to collections (empty = all)</span></p>
 <div class="flex flex-wrap gap-2 p-3 border border-base-300 rounded-lg max-h-28 overflow-y-auto">
 {#each collections as col}
 <label class="flex items-center gap-1.5 cursor-pointer">
 <input type="checkbox" class="checkbox checkbox-xs" checked={form.collections.includes(col.name)} onchange={() => toggleCollection(col.name)} />
 <span class="text-sm">{col.display_name || col.name}</span>
 </label>
 {/each}
 </div>
 </div>
 {/if}
 <label class="label cursor-pointer justify-start gap-3">
 <input type="checkbox" class="toggle toggle-success toggle-sm" bind:checked={form.active} />
 <span class="label-text">Active</span>
 </label>
 </div>
 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showModal = false)}>Cancel</button>
 <button class="btn btn-primary" onclick={save}
 disabled={saving || !form.name || !form.url || form.events.length === 0}>
 {#if saving}<LoaderCircle size={16} class="animate-spin" />{/if}
 {editTarget ? 'Save' : 'Create'}
 </button>
 </div>
 </div>
 <button class="modal-backdrop" aria-label="Close" onclick={() => (showModal = false)}></button>
 </dialog>
{/if}

<ConfirmModal
 open={confirmState.open}
 title={confirmState.title}
 message={confirmState.message}
 confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
 onconfirm={confirmState.onconfirm}
 oncancel={() => (confirmState.open = false)}
/>
