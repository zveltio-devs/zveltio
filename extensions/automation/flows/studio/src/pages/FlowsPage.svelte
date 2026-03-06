<script lang="ts">
 import { onMount } from 'svelte';
 import { Plus, Play, Pause, Trash2, GitBranch } from '@lucide/svelte';

 const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

 let flows = $state<any[]>([]);
 let loading = $state(true);
 let showCreateModal = $state(false);
 let creating = $state(false);
 let runningId = $state<string | null>(null);

 let form = $state({
 name: '',
 description: '',
 trigger: { type: 'manual' as 'data_event' | 'webhook' | 'cron' | 'manual', collection: '', event: 'insert' as 'insert' | 'update' | 'delete', cron: '' },
 });

 onMount(() => loadFlows());

 async function loadFlows() {
 loading = true;
 try {
 const res = await fetch(`${engineUrl}/api/flows`, { credentials: 'include' });
 const data = await res.json();
 flows = data.flows || [];
 } finally {
 loading = false;
 }
 }

 async function createFlow() {
 if (!form.name) return;
 creating = true;
 try {
 const trigger: any = { type: form.trigger.type };
 if (form.trigger.type === 'data_event') {
 trigger.collection = form.trigger.collection;
 trigger.event = form.trigger.event;
 } else if (form.trigger.type === 'cron') {
 trigger.cron = form.trigger.cron;
 }
 const res = await fetch(`${engineUrl}/api/flows`, {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ name: form.name, description: form.description, trigger }),
 });
 const data = await res.json();
 showCreateModal = false;
 window.location.hash = `#/flows/${data.flow.id}/edit`;
 await loadFlows();
 } finally {
 creating = false;
 }
 }

 async function toggleActive(flow: any) {
 await fetch(`${engineUrl}/api/flows/${flow.id}`, {
 method: 'PATCH',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ is_active: !flow.is_active }),
 });
 await loadFlows();
 }

 async function runFlow(id: string) {
 runningId = id;
 try {
 await fetch(`${engineUrl}/api/flows/${id}/run`, { method: 'POST', credentials: 'include' });
 alert('Flow triggered!');
 } finally {
 runningId = null;
 }
 }

 async function deleteFlow(id: string) {
 if (!confirm('Delete this flow?')) return;
 await fetch(`${engineUrl}/api/flows/${id}`, { method: 'DELETE', credentials: 'include' });
 await loadFlows();
 }

 function triggerLabel(trigger: any): string {
 const t = typeof trigger === 'string' ? JSON.parse(trigger) : trigger;
 if (t.type === 'data_event') return `${t.collection} → ${t.event}`;
 if (t.type === 'cron') return `cron: ${t.cron}`;
 if (t.type === 'webhook') return 'Webhook';
 return 'Manual';
 }

 function stepCount(steps: any): number {
 const s = typeof steps === 'string' ? JSON.parse(steps) : steps;
 return Array.isArray(s) ? s.length : 0;
 }
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Automation Flows</h1>
 <p class="text-base-content/60 text-sm mt-1">Build event-driven workflows with visual steps</p>
 </div>
 <button class="btn btn-primary btn-sm gap-2" onclick={() => (showCreateModal = true)}>
 <Plus size={16} />
 New Flow
 </button>
 </div>

 {#if loading}
 <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
 {:else if flows.length === 0}
 <div class="card bg-base-200 text-center py-12">
 <GitBranch size={48} class="mx-auto text-base-content/20 mb-3" />
 <p class="text-base-content/60">No flows yet</p>
 <button class="btn btn-primary btn-sm mt-4" onclick={() => (showCreateModal = true)}>Create First Flow</button>
 </div>
 {:else}
 <div class="space-y-3">
 {#each flows as flow}
 <div class="card bg-base-200">
 <div class="card-body p-4">
 <div class="flex items-start justify-between">
 <div>
 <div class="flex items-center gap-2">
 <h3 class="font-semibold">{flow.name}</h3>
 <span class="badge badge-sm {flow.is_active ? 'badge-success' : 'badge-ghost'}">
 {flow.is_active ? 'active' : 'paused'}
 </span>
 </div>
 {#if flow.description}
 <p class="text-sm text-base-content/60 mt-0.5">{flow.description}</p>
 {/if}
 <div class="flex gap-2 mt-2">
 <span class="badge badge-outline badge-sm">{triggerLabel(flow.trigger)}</span>
 <span class="badge badge-ghost badge-sm">{stepCount(flow.steps)} steps</span>
 </div>
 </div>
 <div class="flex gap-1">
 <button class="btn btn-ghost btn-xs" onclick={() => runFlow(flow.id)} disabled={runningId === flow.id}>
 {#if runningId === flow.id}
 <span class="loading loading-spinner loading-xs"></span>
 {:else}
 <Play size={12} />
 {/if}
 </button>
 <button class="btn btn-ghost btn-xs" onclick={() => toggleActive(flow)}>
 {#if flow.is_active}<Pause size={12} />{:else}<Play size={12} />{/if}
 </button>
 <a href="#/flows/{flow.id}/edit" class="btn btn-ghost btn-xs">Edit</a>
 <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteFlow(flow.id)}>
 <Trash2 size={12} />
 </button>
 </div>
 </div>
 </div>
 </div>
 {/each}
 </div>
 {/if}
</div>

{#if showCreateModal}
 <dialog class="modal modal-open">
 <div class="modal-box">
 <h3 class="font-bold text-lg mb-4">New Flow</h3>

 <div class="space-y-3">
 <div class="form-control">
 <label class="label"><span class="label-text">Name</span></label>
 <input type="text" bind:value={form.name} placeholder="e.g. Notify on new order" class="input" />
 </div>

 <div class="form-control">
 <label class="label"><span class="label-text">Trigger</span></label>
 <select bind:value={form.trigger.type} class="select">
 <option value="manual">Manual</option>
 <option value="data_event">Data Event (insert/update/delete)</option>
 <option value="cron">Scheduled (cron)</option>
 <option value="webhook">Incoming Webhook</option>
 </select>
 </div>

 {#if form.trigger.type === 'data_event'}
 <div class="grid grid-cols-2 gap-2">
 <div class="form-control">
 <label class="label"><span class="label-text">Collection</span></label>
 <input type="text" bind:value={form.trigger.collection} placeholder="orders" class="input input-sm" />
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text">Event</span></label>
 <select bind:value={form.trigger.event} class="select select-sm">
 <option value="insert">Insert</option>
 <option value="update">Update</option>
 <option value="delete">Delete</option>
 </select>
 </div>
 </div>
 {:else if form.trigger.type === 'cron'}
 <div class="form-control">
 <label class="label"><span class="label-text">Cron expression</span></label>
 <input type="text" bind:value={form.trigger.cron} placeholder="0 9 * * 1-5" class="input input-sm font-mono" />
 </div>
 {/if}
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
 <button class="btn btn-primary" onclick={createFlow} disabled={creating}>
 {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
 Create & Edit
 </button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
 </dialog>
{/if}
