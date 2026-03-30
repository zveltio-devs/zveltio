<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { page } from '$app/state';
  import { collectionsApi, api } from '$lib/api.js';
  import { ArrowLeft, Plus, Trash2, ArrowRight, GitFork } from '@lucide/svelte';
  import { base } from '$app/paths';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import Breadcrumb from '$lib/components/common/Breadcrumb.svelte';

  const collectionName = $derived(page.params.name ?? '');
  let relations = $state<any[]>([]);
  let allCollections = $state<any[]>([]);
  let sourceFields = $state<any[]>([]);   // fields of current collection
  let targetFields = $state<any[]>([]);   // fields of selected target collection
  let loading = $state(true);
  let saving = $state(false);
  let showForm = $state(false);
  let error = $state('');
  let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

  let form = $state({
    name: '',
    type: 'o2m' as 'o2m' | 'm2o' | 'm2m' | 'm2a',
    source_collection: untrack(() => collectionName),
    source_field: '',
    target_collection: '',
    target_field: '',
    on_delete: 'SET NULL' as string,
  });

  const relationTypes = [
    { value: 'o2m', label: 'One to Many', desc: 'One record here → many records in target' },
    { value: 'm2o', label: 'Many to One', desc: 'Many records here → one record in target (FK column added here)' },
    { value: 'm2m', label: 'Many to Many', desc: 'Junction table linking both collections' },
    { value: 'm2a', label: 'Many to Any', desc: 'Polymorphic — target can be any collection' },
  ];

  onMount(async () => {
    await load();
  });

  async function load() {
    loading = true;
    const [rRes, cRes] = await Promise.all([
      api.get<{ relations: any[] }>(`/api/relations?collection=${collectionName}`),
      collectionsApi.list(),
    ]);
    relations = rRes.relations || [];
    allCollections = cRes.collections || [];

    // Load source collection fields
    const srcCol = allCollections.find((c) => c.name === collectionName);
    if (srcCol) {
      const f = typeof srcCol.fields === 'string' ? JSON.parse(srcCol.fields) : srcCol.fields;
      sourceFields = f || [];
    }
    loading = false;
  }

  // When target collection changes, load its fields
  async function onTargetChange() {
    form.target_field = '';
    targetFields = [];
    if (!form.target_collection) return;
    const tgt = allCollections.find((c) => c.name === form.target_collection);
    if (tgt) {
      const f = typeof tgt.fields === 'string' ? JSON.parse(tgt.fields) : tgt.fields;
      targetFields = f || [];
    }
  }

  async function addRelation() {
    error = '';
    if (!form.name.trim()) { error = 'Relation name is required'; return; }
    if (!form.source_field.trim()) { error = 'Source field is required'; return; }
    if (!form.target_collection) { error = 'Target collection is required'; return; }

    saving = true;
    try {
      await api.post('/api/relations', { ...form, source_collection: collectionName });
      await load();
      showForm = false;
      form = { name: '', type: 'o2m', source_collection: collectionName, source_field: '', target_collection: '', target_field: '', on_delete: 'SET NULL' };
    } catch (err: any) {
      error = err.message || 'Failed to create relation';
    } finally {
      saving = false;
    }
  }

  async function deleteRelation(id: string, name: string) {
    confirmState = {
      open: true,
      title: 'Delete Relation',
      message: `Delete relation '${name}'?`,
      confirmLabel: 'Delete',
      onconfirm: async () => {
        confirmState.open = false;
        await api.delete(`/api/relations/${id}`);
        relations = relations.filter((r) => r.id !== id);
      },
    };
  }

  function typeColor(type: string): string {
    const map: Record<string, string> = {
      o2m: 'badge-primary', m2o: 'badge-secondary', m2m: 'badge-accent', m2a: 'badge-warning',
    };
    return map[type] || 'badge-ghost';
  }

  function openForm() {
    form = { name: '', type: 'o2m', source_collection: collectionName, source_field: '', target_collection: '', target_field: '', on_delete: 'SET NULL' };
    targetFields = [];
    error = '';
    showForm = true;
  }
</script>

<div class="space-y-6">
  <!-- Breadcrumb -->
  <Breadcrumb crumbs={[
    { label: 'Collections', href: `${base}/collections` },
    { label: collectionName, href: `${base}/collections/${collectionName}` },
    { label: 'Relations' },
  ]} />
  <!-- Header -->
  <div class="flex items-center gap-3">
    <div>
      <h1 class="text-2xl font-bold">
        {collectionName}
        <span class="text-base-content/40 font-normal">/ Relations</span>
      </h1>
      <p class="text-base-content/60 text-sm">Define how this collection links to others</p>
    </div>
    <div class="ml-auto">
      <button class="btn btn-primary btn-sm" onclick={openForm}>
        <Plus size={16} />
        Add Relation
      </button>
    </div>
  </div>

  <!-- Add relation form -->
  {#if showForm}
    <div class="card bg-base-200 border border-primary/30">
      <div class="card-body gap-4">
        <h3 class="font-semibold">New Relation</h3>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <!-- Name -->
          <div class="form-control">
            <label class="label" for="rel_name"><span class="label-text">Relation name</span></label>
            <input id="rel_name" type="text" bind:value={form.name} placeholder="e.g. author_posts" class="input input-sm" autocomplete="off" />
          </div>

          <!-- Type -->
          <div class="form-control">
            <label class="label" for="rel_type"><span class="label-text">Type</span></label>
            <select id="rel_type" bind:value={form.type} class="select select-sm">
              {#each relationTypes as rt}
                <option value={rt.value}>{rt.label}</option>
              {/each}
            </select>
            <p class="text-xs text-base-content/50 mt-1">
              {relationTypes.find(r => r.value === form.type)?.desc}
            </p>
          </div>

          <!-- Source field -->
          <div class="form-control">
            <label class="label" for="source_field">
              <span class="label-text">Source field <span class="text-base-content/40">({collectionName})</span></span>
            </label>
            {#if sourceFields.length > 0}
              <select id="source_field" bind:value={form.source_field} class="select select-sm font-mono">
                <option value="">Select field…</option>
                {#each sourceFields as f}
                  <option value={f.name}>{f.name} <span class="opacity-50">({f.type})</span></option>
                {/each}
                <option value="__new__">＋ New field name…</option>
              </select>
              {#if form.source_field === '__new__'}
                <input
                  type="text"
                  bind:value={form.source_field}
                  placeholder="new_field_name"
                  class="input input-sm font-mono mt-1"
                  oninput={(e) => { if ((e.target as HTMLInputElement).value === '__new__') form.source_field = ''; }}
                />
              {/if}
            {:else}
              <input id="source_field" type="text" bind:value={form.source_field} placeholder="e.g. author_id" class="input input-sm font-mono" />
            {/if}
          </div>

          <!-- Target collection -->
          <div class="form-control">
            <label class="label" for="target_col"><span class="label-text">Target collection</span></label>
            <select id="target_col" bind:value={form.target_collection} onchange={onTargetChange} class="select select-sm">
              <option value="">Select collection…</option>
              {#each allCollections.filter((c) => c.name !== collectionName) as col}
                <option value={col.name}>{col.display_name || col.name}</option>
              {/each}
            </select>
          </div>

          <!-- Target field (dropdown if available) -->
          {#if form.target_collection}
            <div class="form-control">
              <label class="label" for="target_field">
                <span class="label-text">Target field <span class="text-base-content/40">({form.target_collection})</span></span>
                <span class="label-text-alt text-base-content/40">optional</span>
              </label>
              {#if targetFields.length > 0}
                <select id="target_field" bind:value={form.target_field} class="select select-sm font-mono">
                  <option value="">— Primary key (id) —</option>
                  {#each targetFields as f}
                    <option value={f.name}>{f.name} ({f.type})</option>
                  {/each}
                </select>
              {:else}
                <input id="target_field" type="text" bind:value={form.target_field} placeholder="id (default)" class="input input-sm font-mono" />
              {/if}
            </div>
          {/if}

          <!-- On Delete (m2o only) -->
          {#if form.type === 'm2o'}
            <div class="form-control">
              <label class="label" for="on_delete"><span class="label-text">On Delete</span></label>
              <select id="on_delete" bind:value={form.on_delete} class="select select-sm">
                {#each ['SET NULL', 'CASCADE', 'RESTRICT', 'NO ACTION'] as opt}
                  <option>{opt}</option>
                {/each}
              </select>
            </div>
          {/if}
        </div>

        {#if error}
          <p class="text-error text-sm">{error}</p>
        {/if}

        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" onclick={addRelation} disabled={saving}>
            {#if saving}<span class="loading loading-spinner loading-xs"></span>{/if}
            Create Relation
          </button>
          <button class="btn btn-ghost btn-sm" onclick={() => { showForm = false; error = ''; }}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else if relations.length === 0}
    <div class="card bg-base-200">
      <div class="card-body items-center text-center py-12 gap-2">
        <GitFork size={32} class="text-base-content/20" />
        <p class="text-base-content/50 font-medium">No relations defined</p>
        <p class="text-sm text-base-content/40">Use relations to join collections together in queries.</p>
      </div>
    </div>
  {:else}
    <div class="space-y-3">
      {#each relations as rel}
        <div class="card bg-base-200">
          <div class="card-body p-4 flex-row items-center gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold">{rel.name}</span>
                <span class="badge badge-sm {typeColor(rel.type)}">{rel.type.toUpperCase()}</span>
              </div>
              <div class="flex items-center gap-2 mt-1 text-sm text-base-content/60 font-mono">
                <span class="truncate">{rel.source_collection}.{rel.source_field}</span>
                <ArrowRight size={14} class="shrink-0" />
                <span class="truncate">{rel.target_collection}{rel.target_field ? `.${rel.target_field}` : ''}</span>
              </div>
              {#if rel.junction_table}
                <p class="text-xs text-base-content/40 mt-0.5">Junction: {rel.junction_table}</p>
              {/if}
            </div>
            <div class="flex items-center gap-2 shrink-0">
              {#if rel.on_delete}
                <span class="badge badge-ghost badge-sm">{rel.on_delete}</span>
              {/if}
              <button onclick={() => deleteRelation(rel.id, rel.name)} class="btn btn-ghost btn-xs text-error">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
