<script lang="ts">
 import { onMount } from 'svelte';

 const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

 let workflows = $state<any[]>([]);
 let collections = $state<any[]>([]);
 let loading = $state(true);
 let showCreateModal = $state(false);
 let creating = $state(false);

 let form = $state({
 name: '',
 description: '',
 collection: '',
 trigger_field: '',
 trigger_value: '',
 steps: [{ name: '', approver_role: 'manager', deadline_hours: null as number | null }],
 });

 onMount(async () => {
 await Promise.all([loadWorkflows(), loadCollections()]);
 });

 async function loadWorkflows() {
 loading = true;
 try {
 const res = await fetch(`${engineUrl}/api/approvals/workflows`, { credentials: 'include' });
 const data = await res.json();
 workflows = data.workflows || [];
 } finally {
 loading = false;
 }
 }

 async function loadCollections() {
 const res = await fetch(`${engineUrl}/api/collections`, { credentials: 'include' });
 const data = await res.json();
 collections = data.collections || [];
 }

 function addStep() {
 form.steps = [...form.steps, { name: '', approver_role: 'manager', deadline_hours: null }];
 }

 function removeStep(i: number) {
 form.steps = form.steps.filter((_, idx) => idx !== i);
 }

 async function createWorkflow() {
 if (!form.name || !form.collection || form.steps.some((s) => !s.name)) return;
 creating = true;
 try {
 const res = await fetch(`${engineUrl}/api/approvals/workflows`, {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(form),
 });

 if (!res.ok) {
 const err = await res.json();
 throw new Error(err.error || 'Failed to create workflow');
 }

 showCreateModal = false;
 form = {
 name: '',
 description: '',
 collection: '',
 trigger_field: '',
 trigger_value: '',
 steps: [{ name: '', approver_role: 'manager', deadline_hours: null }],
 };
 await loadWorkflows();
 } catch (err) {
 alert(err instanceof Error ? err.message : 'Failed to create workflow');
 } finally {
 creating = false;
 }
 }

 async function deleteWorkflow(id: string) {
 if (!confirm('Delete this workflow?')) return;
 await fetch(`${engineUrl}/api/approvals/workflows/${id}`, {
 method: 'DELETE',
 credentials: 'include',
 });
 await loadWorkflows();
 }
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Approval Workflows</h1>
 <p class="text-base-content/60 text-sm mt-1">Define multi-step approval processes</p>
 </div>
 <button class="btn btn-primary btn-sm" onclick={() => (showCreateModal = true)}>
 + New Workflow
 </button>
 </div>

 {#if loading}
 <div class="flex justify-center py-12">
 <span class="loading loading-spinner loading-lg"></span>
 </div>
 {:else if workflows.length === 0}
 <div class="card bg-base-200 text-center py-12">
 <p class="text-base-content/60">No workflows yet</p>
 <button class="btn btn-primary btn-sm mt-4" onclick={() => (showCreateModal = true)}>
 Create First Workflow
 </button>
 </div>
 {:else}
 <div class="space-y-3">
 {#each workflows as wf}
 <div class="card bg-base-200">
 <div class="card-body p-4">
 <div class="flex items-start justify-between">
 <div>
 <div class="flex items-center gap-2">
 <h3 class="font-semibold">{wf.name}</h3>
 {#if !wf.is_active}
 <span class="badge badge-ghost badge-sm">inactive</span>
 {/if}
 </div>
 <p class="text-sm text-base-content/60 mt-0.5">
 Collection: <code class="font-mono">{wf.collection}</code>
 </p>
 {#if wf.description}
 <p class="text-sm text-base-content/50 mt-1">{wf.description}</p>
 {/if}
 <div class="mt-2 flex gap-2">
 <span class="badge badge-outline badge-sm">{wf.step_count} steps</span>
 {#if wf.trigger_field}
 <span class="badge badge-info badge-sm">
 trigger: {wf.trigger_field} = {wf.trigger_value}
 </span>
 {/if}
 </div>
 </div>
 <button
 onclick={() => deleteWorkflow(wf.id)}
 class="btn btn-ghost btn-xs text-error"
 >
 Delete
 </button>
 </div>
 </div>
 </div>
 {/each}
 </div>
 {/if}
</div>

{#if showCreateModal}
 <dialog class="modal modal-open">
 <div class="modal-box w-11/12 max-w-2xl">
 <h3 class="font-bold text-lg mb-4">Create Workflow</h3>

 <div class="grid grid-cols-2 gap-4 mb-4">
 <div class="form-control col-span-2">
 <label class="label"><span class="label-text">Workflow name</span></label>
 <input type="text" bind:value={form.name} placeholder="e.g. Document Approval" class="input" />
 </div>

 <div class="form-control col-span-2">
 <label class="label"><span class="label-text">Collection</span></label>
 <select bind:value={form.collection} class="select">
 <option value="">Select collection...</option>
 {#each collections as col}
 <option value={col.name}>{col.display_name || col.name}</option>
 {/each}
 </select>
 </div>

 <div class="form-control">
 <label class="label"><span class="label-text">Trigger field (optional)</span></label>
 <input type="text" bind:value={form.trigger_field} placeholder="status" class="input input-sm" />
 </div>

 <div class="form-control">
 <label class="label"><span class="label-text">Trigger value</span></label>
 <input type="text" bind:value={form.trigger_value} placeholder="pending_approval" class="input input-sm" />
 </div>
 </div>

 <!-- Steps -->
 <div class="mb-4">
 <div class="flex items-center justify-between mb-2">
 <label class="label-text font-medium">Approval Steps</label>
 <button class="btn btn-ghost btn-xs" onclick={addStep}>+ Add step</button>
 </div>

 <div class="space-y-2">
 {#each form.steps as step, i}
 <div class="card bg-base-200">
 <div class="card-body p-3">
 <div class="flex gap-2 items-start">
 <div class="flex-1 space-y-2">
 <input
 type="text"
 bind:value={step.name}
 placeholder="Step name (e.g. Manager Approval)"
 class="input input-sm w-full"
 />
 <div class="flex gap-2">
 <select bind:value={step.approver_role} class="select select-sm flex-1">
 <option value="admin">Admin</option>
 <option value="manager">Manager</option>
 <option value="member">Member</option>
 </select>
 <input
 type="number"
 bind:value={step.deadline_hours}
 placeholder="Deadline (hours)"
 class="input input-sm w-40"
 />
 </div>
 </div>
 {#if form.steps.length > 1}
 <button onclick={() => removeStep(i)} class="btn btn-ghost btn-xs text-error mt-1">✕</button>
 {/if}
 </div>
 </div>
 </div>
 {/each}
 </div>
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
 <button class="btn btn-primary" onclick={createWorkflow} disabled={creating}>
 {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
 Create
 </button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
 </dialog>
{/if}
