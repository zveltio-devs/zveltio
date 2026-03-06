<script lang="ts">
 import { onMount } from 'svelte';
 import { api } from '$lib/api.js';
 import { Plus, Play, Pause, Trash2, Loader2, Workflow, Zap, Clock, Webhook, RefreshCw } from '@lucide/svelte';

 interface Flow {
 id: string;
 name: string;
 description: string | null;
 trigger_type: string;
 trigger_config: Record<string, any>;
 is_active: boolean;
 total_runs?: number;
 last_run_at?: string;
 created_at: string;
 updated_at: string;
 }

 let flows = $state<Flow[]>([]);
 let loading = $state(true);
 let error = $state('');
 let showModal = $state(false);
 let saving = $state(false);
 let formError = $state('');

 // Form state
 let name = $state('');
 let description = $state('');
 let triggerType = $state('manual');
 let triggerCollection = $state('');
 let triggerCron = $state('0 * * * *');
 let isActive = $state(true);

 onMount(loadFlows);

 async function loadFlows() {
 loading = true;
 error = '';
 try {
 const data = await api.get<{ flows: Flow[] }>('/api/flows');
 flows = data.flows || [];
 } catch (e: any) {
 error = e.message;
 } finally {
 loading = false;
 }
 }

 function openModal() {
 name = '';
 description = '';
 triggerType = 'manual';
 triggerCollection = '';
 triggerCron = '0 * * * *';
 isActive = true;
 formError = '';
 showModal = true;
 }

 async function createFlow() {
 if (!name.trim()) { formError = 'Name is required'; return; }
 saving = true;
 formError = '';
 try {
 const triggerConfig: Record<string, any> = {};
 if (triggerType === 'cron') triggerConfig.expression = triggerCron;
 if (['on_create', 'on_update', 'on_delete'].includes(triggerType) && triggerCollection)
 triggerConfig.collection = triggerCollection;

 const data = await api.post<{ flow: Flow }>('/api/flows', {
 name: name.trim(),
 description: description.trim() || undefined,
 trigger_type: triggerType,
 trigger_config: triggerConfig,
 is_active: isActive,
 });
 flows = [data.flow, ...flows];
 showModal = false;
 } catch (e: any) {
 formError = e.message;
 } finally {
 saving = false;
 }
 }

 async function toggleFlow(flow: Flow) {
 try {
 const data = await api.patch<{ flow: Flow }>(`/api/flows/${flow.id}`, {
 is_active: !flow.is_active,
 });
 flows = flows.map(f => f.id === flow.id ? data.flow : f);
 } catch (e: any) {
 error = e.message;
 }
 }

 async function deleteFlow(id: string, flowName: string) {
 if (!confirm(`Delete flow "${flowName}"?`)) return;
 try {
 await api.delete(`/api/flows/${id}`);
 flows = flows.filter(f => f.id !== id);
 } catch (e: any) {
 error = e.message;
 }
 }

 async function runFlow(id: string) {
 try {
 await api.post(`/api/flows/${id}/run`, {});
 await loadFlows();
 } catch (e: any) {
 error = e.message;
 }
 }

 function triggerIcon(triggerType: string) {
 if (triggerType === 'cron') return Clock;
 if (triggerType === 'webhook') return Webhook;
 if (['on_create', 'on_update', 'on_delete'].includes(triggerType)) return Zap;
 return Play;
 }

 function triggerLabel(flow: Flow): string {
 switch (flow.trigger_type) {
 case 'on_create': return `${flow.trigger_config?.collection || '*'} → insert`;
 case 'on_update': return `${flow.trigger_config?.collection || '*'} → update`;
 case 'on_delete': return `${flow.trigger_config?.collection || '*'} → delete`;
 case 'cron': return `Cron: ${flow.trigger_config?.expression || '?'}`;
 case 'webhook': return 'Webhook';
 default: return 'Manual';
 }
 }

 function fmt(s?: string) {
 if (!s) return '—';
 return new Date(s).toLocaleDateString();
 }
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">Flows</h1>
 <p class="text-base-content/60 text-sm mt-1">Automate actions with trigger → step pipelines</p>
 </div>
 <div class="flex gap-2">
 <button class="btn btn-ghost btn-sm" onclick={loadFlows} disabled={loading}>
 <RefreshCw size={16} class={loading ? 'animate-spin' : ''} />
 </button>
 <button class="btn btn-primary btn-sm" onclick={openModal}>
 <Plus size={16} /> New Flow
 </button>
 </div>
 </div>

 {#if error}
 <div class="alert alert-error text-sm">{error}</div>
 {/if}

 {#if loading}
 <div class="flex justify-center py-16">
 <Loader2 size={32} class="animate-spin text-primary" />
 </div>
 {:else if flows.length === 0}
 <div class="text-center py-16 text-base-content/40">
 <Workflow size={48} class="mx-auto mb-3" />
 <p class="text-sm">No flows yet.</p>
 <button class="btn btn-primary btn-sm mt-4" onclick={openModal}>
 <Plus size={14} /> Create First Flow
 </button>
 </div>
 {:else}
 <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
 {#each flows as flow}
 {@const TriggerIcon = triggerIcon(flow.trigger_type)}
 <div class="card bg-base-200 {!flow.is_active ? 'opacity-60' : ''}">
 <div class="card-body p-4 space-y-3">
 <div class="flex items-start justify-between gap-2">
 <div class="flex-1 min-w-0">
 <p class="font-semibold text-sm truncate">{flow.name}</p>
 {#if flow.description}
 <p class="text-xs text-base-content/50 truncate">{flow.description}</p>
 {/if}
 </div>
 <span class="badge badge-sm shrink-0 {flow.is_active ? 'badge-success' : 'badge-ghost'}">
 {flow.is_active ? 'Active' : 'Paused'}
 </span>
 </div>

 <div class="flex items-center gap-1.5 text-xs text-base-content/60">
 <TriggerIcon size={13} />
 <span>{triggerLabel(flow)}</span>
 {#if flow.total_runs}
 <span class="ml-auto opacity-50">{flow.total_runs} runs</span>
 {/if}
 </div>

 <div class="text-xs text-base-content/40">Updated {fmt(flow.updated_at)}</div>

 <div class="flex gap-1 pt-1 border-t border-base-300">
 <button
 class="btn btn-ghost btn-xs flex-1"
 onclick={() => toggleFlow(flow)}
 title={flow.is_active ? 'Pause' : 'Resume'}
 >
 {#if flow.is_active}<Pause size={13} />{:else}<Play size={13} />{/if}
 {flow.is_active ? 'Pause' : 'Resume'}
 </button>
 <button
 class="btn btn-ghost btn-xs"
 onclick={() => runFlow(flow.id)}
 title="Run now"
 >
 <Play size={13} />
 </button>
 <button
 class="btn btn-ghost btn-xs text-error"
 onclick={() => deleteFlow(flow.id, flow.name)}
 >
 <Trash2 size={13} />
 </button>
 </div>
 </div>
 </div>
 {/each}
 </div>
 {/if}
</div>

<!-- Create flow modal -->
{#if showModal}
 <div class="modal modal-open">
 <div class="modal-box max-w-md">
 <h3 class="font-bold text-lg mb-4">New Flow</h3>
 <div class="space-y-4">
 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Name *</span></label>
 <input class="input" bind:value={name} placeholder="e.g. Send welcome email" />
 </div>

 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Description</span></label>
 <input class="input" bind:value={description} placeholder="Optional" />
 </div>

 <div class="form-control">
 <label class="label"><span class="label-text font-medium">Trigger</span></label>
 <select class="select" bind:value={triggerType}>
 <option value="manual">Manual</option>
 <option value="on_create">On Create</option>
 <option value="on_update">On Update</option>
 <option value="on_delete">On Delete</option>
 <option value="cron">Schedule (Cron)</option>
 <option value="webhook">Webhook</option>
 </select>
 </div>

 {#if ['on_create', 'on_update', 'on_delete'].includes(triggerType)}
 <div class="form-control">
 <label class="label"><span class="label-text text-xs">Collection (optional)</span></label>
 <input
 class="input input-sm"
 bind:value={triggerCollection}
 placeholder="collection_name"
 />
 </div>
 {:else if triggerType === 'cron'}
 <div class="form-control">
 <label class="label">
 <span class="label-text text-xs">Cron expression</span>
 <span class="label-text-alt text-xs text-base-content/50">e.g. 0 9 * * 1 (Mon 9am)</span>
 </label>
 <input
 class="input input-sm font-mono"
 bind:value={triggerCron}
 placeholder="0 * * * *"
 />
 </div>
 {/if}

 <label class="flex items-center gap-2 cursor-pointer">
 <input type="checkbox" class="checkbox checkbox-sm checkbox-primary" bind:checked={isActive} />
 <span class="text-sm">Active immediately</span>
 </label>

 {#if formError}
 <p class="text-error text-sm">{formError}</p>
 {/if}
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showModal = false)}>Cancel</button>
 <button class="btn btn-primary" onclick={createFlow} disabled={saving || !name}>
 {#if saving}<Loader2 size={16} class="animate-spin" />{/if}
 Create Flow
 </button>
 </div>
 </div>
 <div
 class="modal-backdrop"
 role="button"
 tabindex="0"
 aria-label="Close"
 onclick={() => (showModal = false)}
 onkeydown={(e) => { if (e.key === 'Escape') showModal = false; }}
 ></div>
 </div>
{/if}
