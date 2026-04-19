<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import {
    Plus, Trash2, Save, LoaderCircle, ChevronRight,
    CheckSquare, BarChart2, ClipboardList,
  } from '@lucide/svelte';

  type ChecklistItem = { id: string; text: string; required?: boolean };
  type Checklist = { id: string; name: string; description: string | null; items: ChecklistItem[]; is_active: boolean; created_at: string };
  type Response = { id: string; checklist_id: string; submitted_by: string | null; answers: Record<string, boolean | string>; notes: string | null; created_at: string };

  let checklists = $state<Checklist[]>([]);
  let loading = $state(true);
  let selected = $state<Checklist | null>(null);
  let responses = $state<Response[]>([]);
  let loadingResponses = $state(false);
  let view = $state<'list' | 'edit' | 'responses'>('list');

  let showNew = $state(false);
  let saving = $state(false);
  let form = $state({ name: '', description: '' });
  let editItems = $state<ChecklistItem[]>([]);
  let newItemText = $state('');

  function extractError(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object') {
      const o = e as any;
      return o.message ?? o.error ?? 'Unknown error';
    }
    return String(e);
  }

  onMount(load);

  async function load() {
    loading = true;
    try {
      const res = await api.get<{ checklists: Checklist[] }>('/api/ext/checklists');
      checklists = res.checklists ?? [];
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      loading = false;
    }
  }

  async function createChecklist() {
    if (!form.name.trim()) return;
    saving = true;
    try {
      const res = await api.post<{ checklist: Checklist }>('/api/ext/checklists', {
        name: form.name.trim(),
        description: form.description || null,
        items: [],
      });
      checklists = [res.checklist, ...checklists];
      form = { name: '', description: '' };
      showNew = false;
      openEdit(res.checklist);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  function openEdit(c: Checklist) {
    selected = c;
    editItems = (c.items ?? []).map(i => ({ ...i }));
    view = 'edit';
  }

  async function saveChecklist() {
    if (!selected) return;
    saving = true;
    try {
      const res = await api.put<{ checklist: Checklist }>(`/api/ext/checklists/${selected.id}`, {
        name: selected.name,
        description: selected.description || null,
        items: editItems,
        is_active: selected.is_active,
      });
      selected = res.checklist;
      checklists = checklists.map(c => c.id === res.checklist.id ? res.checklist : c);
      toast.success('Checklist saved.');
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      saving = false;
    }
  }

  async function deleteChecklist(id: string) {
    if (!confirm('Delete this checklist?')) return;
    try {
      await api.delete(`/api/ext/checklists/${id}`);
      checklists = checklists.filter(c => c.id !== id);
      if (selected?.id === id) { selected = null; view = 'list'; }
    } catch (e) {
      toast.error(extractError(e));
    }
  }

  async function openResponses(c: Checklist) {
    selected = c;
    view = 'responses';
    loadingResponses = true;
    try {
      const res = await api.get<{ responses: Response[] }>(`/api/ext/checklists/${c.id}/responses`);
      responses = res.responses ?? [];
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      loadingResponses = false;
    }
  }

  function addItem() {
    if (!newItemText.trim()) return;
    editItems = [...editItems, { id: crypto.randomUUID(), text: newItemText.trim(), required: false }];
    newItemText = '';
  }

  function removeItem(id: string) {
    editItems = editItems.filter(i => i.id !== id);
  }
</script>

<div class="space-y-5">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      {#if view !== 'list'}
        <button class="btn btn-ghost btn-sm" onclick={() => { view = 'list'; selected = null; }}>← Back</button>
        <span class="text-base-content/30">/</span>
      {/if}
      <div>
        <h1 class="text-xl font-semibold">Checklists</h1>
        {#if selected && view !== 'list'}
          <p class="text-sm text-base-content/50">{selected.name}</p>
        {/if}
      </div>
    </div>
    {#if view === 'list'}
      <button class="btn btn-primary btn-sm gap-1" onclick={() => (showNew = !showNew)}>
        <Plus size={14}/> New Checklist
      </button>
    {:else if view === 'edit'}
      <button class="btn btn-primary btn-sm gap-1" onclick={saveChecklist} disabled={saving}>
        {#if saving}<LoaderCircle size={14} class="animate-spin"/>{:else}<Save size={14}/>{/if}
        Save
      </button>
    {/if}
  </div>

  <!-- Create form -->
  {#if showNew && view === 'list'}
    <div class="card bg-base-200 border border-primary/30">
      <div class="card-body p-4 gap-3">
        <h4 class="font-semibold text-sm">New Checklist</h4>
        <div class="grid sm:grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Name *</span></label>
            <input type="text" class="input input-sm" placeholder="e.g. Onboarding Checklist" bind:value={form.name}/>
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">Description</span></label>
            <input type="text" class="input input-sm" bind:value={form.description}/>
          </div>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm gap-1" onclick={createChecklist} disabled={!form.name.trim() || saving}>
            {#if saving}<LoaderCircle size={13} class="animate-spin"/>{:else}<Plus size={13}/>{/if}
            Create
          </button>
          <button class="btn btn-ghost btn-sm" onclick={() => (showNew = false)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- List view -->
  {#if view === 'list'}
    {#if loading}
      <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary"/></div>
    {:else if checklists.length === 0}
      <div class="card bg-base-200">
        <div class="card-body items-center text-center py-16 gap-3">
          <ClipboardList size={36} class="text-base-content/20"/>
          <p class="font-medium text-sm text-base-content/50">No checklists yet</p>
          <p class="text-xs text-base-content/40">Create your first checklist to get started.</p>
        </div>
      </div>
    {:else}
      <div class="space-y-2">
        {#each checklists as c (c.id)}
          <div class="card bg-base-200 hover:bg-base-300 transition-colors">
            <div class="card-body p-3 flex-row items-center gap-3">
              <CheckSquare size={16} class="text-primary shrink-0"/>
              <div class="flex-1 min-w-0">
                <p class="font-medium text-sm truncate">{c.name}</p>
                <p class="text-xs text-base-content/40">{(c.items ?? []).length} item{(c.items ?? []).length !== 1 ? 's' : ''}</p>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button class="btn btn-ghost btn-xs gap-1" onclick={() => openResponses(c)}>
                  <BarChart2 size={13}/> Responses
                </button>
                <button class="btn btn-ghost btn-xs gap-1" onclick={() => openEdit(c)}>
                  Edit <ChevronRight size={13}/>
                </button>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteChecklist(c.id)}>
                  <Trash2 size={13}/>
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

  <!-- Edit view -->
  {:else if view === 'edit' && selected}
    <div class="card bg-base-200 border border-base-300 max-w-2xl">
      <div class="card-body gap-4">
        <div class="grid sm:grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs font-medium">Name</span></label>
            <input type="text" class="input input-sm" bind:value={selected.name}/>
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs font-medium">Description</span></label>
            <input type="text" class="input input-sm" bind:value={selected.description}/>
          </div>
        </div>

        <div>
          <p class="text-xs font-medium text-base-content/70 mb-2">Items</p>
          <div class="space-y-1.5 mb-3">
            {#each editItems as item (item.id)}
              <div class="flex items-center gap-2 bg-base-100 rounded-lg px-3 py-2">
                <CheckSquare size={13} class="text-base-content/30 shrink-0"/>
                <span class="flex-1 text-sm">{item.text}</span>
                <label class="flex items-center gap-1 text-xs text-base-content/50">
                  <input type="checkbox" class="checkbox checkbox-xs" bind:checked={item.required}/>
                  Required
                </label>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => removeItem(item.id)}>
                  <Trash2 size={12}/>
                </button>
              </div>
            {:else}
              <p class="text-xs text-base-content/40 py-2">No items yet. Add some below.</p>
            {/each}
          </div>
          <div class="flex gap-2">
            <input type="text" class="input input-sm flex-1" placeholder="New item text…"
              bind:value={newItemText}
              onkeydown={(e) => e.key === 'Enter' && addItem()}/>
            <button class="btn btn-outline btn-sm gap-1" onclick={addItem} disabled={!newItemText.trim()}>
              <Plus size={13}/> Add
            </button>
          </div>
        </div>
      </div>
    </div>

  <!-- Responses view -->
  {:else if view === 'responses' && selected}
    {#if loadingResponses}
      <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary"/></div>
    {:else if responses.length === 0}
      <div class="card bg-base-200">
        <div class="card-body items-center text-center py-16 gap-3">
          <BarChart2 size={36} class="text-base-content/20"/>
          <p class="font-medium text-sm text-base-content/50">No responses yet</p>
        </div>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>Submitted by</th>
              <th>Date</th>
              <th>Notes</th>
              <th>Answers</th>
            </tr>
          </thead>
          <tbody>
            {#each responses as r (r.id)}
              <tr class="hover">
                <td class="font-mono text-xs">{r.submitted_by ?? '—'}</td>
                <td class="text-xs">{new Date(r.created_at).toLocaleString()}</td>
                <td class="text-xs text-base-content/60">{r.notes ?? '—'}</td>
                <td>
                  <div class="flex flex-wrap gap-1">
                    {#each Object.entries(r.answers ?? {}) as [k, v]}
                      <span class="badge badge-xs {v ? 'badge-success' : 'badge-error'}">{k}</span>
                    {/each}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>
