<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { Plus, Play, Pause, Trash2, Loader2, Workflow, Zap, Clock, Webhook } from '@lucide/svelte';

  interface Flow {
    id: string;
    name: string;
    description: string | null;
    trigger: string | { type: string; collection?: string; event?: string; cron?: string };
    steps: any[] | string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }

  let flows = $state<Flow[]>([]);
  let loading = $state(true);
  let showModal = $state(false);
  let saving = $state(false);
  let formError = $state('');

  // Form state
  let name = $state('');
  let description = $state('');
  let triggerType = $state<'data_event' | 'webhook' | 'cron' | 'manual'>('manual');
  let triggerCollection = $state('');
  let triggerEvent = $state<'insert' | 'update' | 'delete'>('insert');
  let triggerCron = $state('0 * * * *');
  let isActive = $state(true);

  onMount(loadFlows);

  async function loadFlows() {
    loading = true;
    try {
      const data = await api.get<{ flows: Flow[] }>('/api/flows');
      flows = data.flows || [];
    } catch { flows = []; }
    finally { loading = false; }
  }

  function openModal() {
    name = '';
    description = '';
    triggerType = 'manual';
    triggerCollection = '';
    triggerEvent = 'insert';
    triggerCron = '0 * * * *';
    isActive = true;
    formError = '';
    showModal = true;
  }

  async function createFlow() {
    if (!name.trim()) { formError = 'Name is required'; return; }
    saving = true; formError = '';
    try {
      const trigger: any = { type: triggerType };
      if (triggerType === 'data_event') {
        trigger.collection = triggerCollection;
        trigger.event = triggerEvent;
      } else if (triggerType === 'cron') {
        trigger.cron = triggerCron;
      }
      const data = await api.post<{ flow: Flow }>('/api/flows', {
        name: name.trim(),
        description: description.trim() || undefined,
        trigger,
        steps: [],
        is_active: isActive,
      });
      flows = [data.flow, ...flows];
      showModal = false;
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Failed to create flow';
    } finally { saving = false; }
  }

  async function toggleFlow(flow: Flow) {
    try {
      const data = await api.patch<{ flow: Flow }>(`/api/flows/${flow.id}`, {
        is_active: !flow.is_active,
      });
      flows = flows.map(f => f.id === flow.id ? data.flow : f);
    } catch { /* silent */ }
  }

  async function deleteFlow(id: string, flowName: string) {
    if (!confirm(`Delete flow "${flowName}"?`)) return;
    try {
      await api.delete(`/api/flows/${id}`);
      flows = flows.filter(f => f.id !== id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete flow');
    }
  }

  function parseTrigger(t: any): string {
    const trigger = typeof t === 'string' ? JSON.parse(t) : t;
    if (!trigger) return 'Manual';
    switch (trigger.type) {
      case 'data_event': return `${trigger.collection || '*'} → ${trigger.event || 'any'}`;
      case 'webhook': return 'Webhook';
      case 'cron': return `Cron: ${trigger.cron || '?'}`;
      default: return 'Manual';
    }
  }

  function triggerIcon(t: any) {
    const trigger = typeof t === 'string' ? JSON.parse(t) : t;
    if (!trigger) return Zap;
    switch (trigger.type) {
      case 'data_event': return Zap;
      case 'webhook': return Webhook;
      case 'cron': return Clock;
      default: return Play;
    }
  }

  function stepsCount(steps: any): number {
    const arr = typeof steps === 'string' ? JSON.parse(steps) : steps;
    return Array.isArray(arr) ? arr.length : 0;
  }

  function fmt(s: string) {
    return new Date(s).toLocaleDateString();
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Flows</h1>
      <p class="text-base-content/60 text-sm mt-1">Automate actions with trigger → step pipelines</p>
    </div>
    <button class="btn btn-primary btn-sm" onclick={openModal}>
      <Plus size={16} /> New Flow
    </button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><Loader2 size={32} class="animate-spin text-primary" /></div>
  {:else if flows.length === 0}
    <div class="text-center py-16 text-base-content/40">
      <Workflow size={48} class="mx-auto mb-3" />
      <p class="text-sm">No flows yet.</p>
      <p class="text-xs mt-1">Create a flow to automate actions on data events, webhooks, or schedules.</p>
      <button class="btn btn-primary btn-sm mt-4" onclick={openModal}>
        <Plus size={14} /> Create First Flow
      </button>
    </div>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each flows as flow}
        {@const TriggerIcon = triggerIcon(flow.trigger)}
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
              <span>{parseTrigger(flow.trigger)}</span>
              <span class="ml-auto">{stepsCount(flow.steps)} step{stepsCount(flow.steps) !== 1 ? 's' : ''}</span>
            </div>

            <div class="text-xs text-base-content/40">Updated {fmt(flow.updated_at)}</div>

            <div class="flex gap-1 pt-1 border-t border-base-300">
              <button class="btn btn-ghost btn-xs flex-1" onclick={() => toggleFlow(flow)}
                title={flow.is_active ? 'Pause' : 'Resume'}>
                {#if flow.is_active}<Pause size={13} />{:else}<Play size={13} />{/if}
                {flow.is_active ? 'Pause' : 'Resume'}
              </button>
              <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteFlow(flow.id, flow.name)}>
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
          <input class="input input-bordered" bind:value={name} placeholder="e.g. Send welcome email" />
        </div>

        <div class="form-control">
          <label class="label"><span class="label-text font-medium">Description</span></label>
          <input class="input input-bordered" bind:value={description} placeholder="Optional" />
        </div>

        <div class="form-control">
          <label class="label"><span class="label-text font-medium">Trigger</span></label>
          <select class="select select-bordered" bind:value={triggerType}>
            <option value="manual">Manual</option>
            <option value="data_event">Data Event</option>
            <option value="webhook">Webhook</option>
            <option value="cron">Schedule (Cron)</option>
          </select>
        </div>

        {#if triggerType === 'data_event'}
          <div class="grid grid-cols-2 gap-3">
            <div class="form-control">
              <label class="label"><span class="label-text text-xs">Collection</span></label>
              <input class="input input-bordered input-sm" bind:value={triggerCollection} placeholder="collection_name" />
            </div>
            <div class="form-control">
              <label class="label"><span class="label-text text-xs">Event</span></label>
              <select class="select select-bordered select-sm" bind:value={triggerEvent}>
                <option value="insert">Insert</option>
                <option value="update">Update</option>
                <option value="delete">Delete</option>
              </select>
            </div>
          </div>
        {:else if triggerType === 'cron'}
          <div class="form-control">
            <label class="label">
              <span class="label-text text-xs">Cron expression</span>
              <span class="label-text-alt text-xs text-base-content/50">e.g. 0 9 * * 1 (Mon 9am)</span>
            </label>
            <input class="input input-bordered input-sm font-mono" bind:value={triggerCron}
              placeholder="0 * * * *" />
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
        <button class="btn btn-primary" onclick={createFlow} disabled={saving}>
          {#if saving}<Loader2 size={16} class="animate-spin" />{/if}
          Create Flow
        </button>
      </div>
    </div>
    <div class="modal-backdrop" onclick={() => (showModal = false)}></div>
  </div>
{/if}
