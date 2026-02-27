<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { collectionsApi, api } from '$lib/api.js';
  import { ArrowLeft, Plus, Trash2, ArrowRight } from '@lucide/svelte';
  import { base } from '$app/paths';

  const collectionName = $derived($page.params.name);
  let relations = $state<any[]>([]);
  let allCollections = $state<any[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let showForm = $state(false);
  let error = $state('');

  let form = $state({
    name: '',
    type: 'o2m' as 'o2m' | 'm2o' | 'm2m' | 'm2a',
    source_collection: collectionName,
    source_field: '',
    target_collection: '',
    target_field: '',
    on_delete: 'SET NULL' as string,
  });

  const relationTypes = [
    { value: 'o2m', label: 'One to Many', desc: 'This collection → many in target' },
    { value: 'm2o', label: 'Many to One', desc: 'Many in this → one in target (FK)' },
    { value: 'm2m', label: 'Many to Many', desc: 'Junction table (both ways)' },
    { value: 'm2a', label: 'Many to Any', desc: 'Polymorphic (target can be any collection)' },
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
    loading = false;
  }

  async function addRelation() {
    error = '';
    if (!form.name.trim()) { error = 'Relation name is required'; return; }
    if (!form.source_field.trim()) { error = 'Source field name is required'; return; }
    if (!form.target_collection) { error = 'Target collection is required'; return; }

    saving = true;
    try {
      await api.post('/api/relations', {
        ...form,
        source_collection: collectionName,
      });
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
    if (!confirm(`Delete relation '${name}'?`)) return;
    await api.delete(`/api/relations/${id}`);
    relations = relations.filter((r) => r.id !== id);
  }

  function typeColor(type: string): string {
    const map: Record<string, string> = {
      o2m: 'badge-primary',
      m2o: 'badge-secondary',
      m2m: 'badge-accent',
      m2a: 'badge-warning',
    };
    return map[type] || 'badge-ghost';
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center gap-3">
    <a href="{base}/collections/{collectionName}" class="btn btn-ghost btn-sm">
      <ArrowLeft size={16} />
    </a>
    <div>
      <h1 class="text-2xl font-bold">
        {collectionName}
        <span class="text-base-content/40 font-normal">/ Relations</span>
      </h1>
      <p class="text-base-content/60 text-sm">Define how this collection links to others</p>
    </div>
    <div class="ml-auto">
      <button class="btn btn-primary btn-sm" onclick={() => (showForm = !showForm)}>
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

        <div class="grid grid-cols-2 gap-4">
          <div class="form-control">
            <label class="label" for="rel_name"><span class="label-text">Relation name</span></label>
            <input
              id="rel_name"
              type="text"
              bind:value={form.name}
              placeholder="e.g. author_posts"
              class="input input-bordered input-sm"
            />
          </div>

          <div class="form-control">
            <label class="label" for="rel_type"><span class="label-text">Type</span></label>
            <select id="rel_type" bind:value={form.type} class="select select-bordered select-sm">
              {#each relationTypes as rt}
                <option value={rt.value}>{rt.label} — {rt.desc}</option>
              {/each}
            </select>
          </div>

          <div class="form-control">
            <label class="label" for="source_field"><span class="label-text">Source field name</span></label>
            <input
              id="source_field"
              type="text"
              bind:value={form.source_field}
              placeholder="e.g. author_id"
              class="input input-bordered input-sm font-mono"
            />
          </div>

          <div class="form-control">
            <label class="label" for="target_col"><span class="label-text">Target collection</span></label>
            <select id="target_col" bind:value={form.target_collection} class="select select-bordered select-sm">
              <option value="">Select collection…</option>
              {#each allCollections.filter((c) => c.name !== collectionName) as col}
                <option value={col.name}>{col.display_name || col.name}</option>
              {/each}
            </select>
          </div>

          {#if form.type === 'm2o'}
            <div class="form-control">
              <label class="label" for="on_delete"><span class="label-text">On Delete</span></label>
              <select id="on_delete" bind:value={form.on_delete} class="select select-bordered select-sm">
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
            {saving ? 'Creating…' : 'Create Relation'}
          </button>
          <button class="btn btn-ghost btn-sm" onclick={() => { showForm = false; error = ''; }}>
            Cancel
          </button>
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
      <div class="card-body items-center text-center py-12">
        <p class="text-base-content/50">No relations defined for this collection.</p>
        <p class="text-sm text-base-content/40 mt-1">Use relations to join collections together in queries.</p>
      </div>
    </div>
  {:else}
    <div class="space-y-3">
      {#each relations as rel}
        <div class="card bg-base-200">
          <div class="card-body p-4 flex-row items-center gap-4">
            <div class="flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold">{rel.name}</span>
                <span class="badge badge-sm {typeColor(rel.type)}">{rel.type.toUpperCase()}</span>
              </div>
              <div class="flex items-center gap-2 mt-1 text-sm text-base-content/60 font-mono">
                <span>{rel.source_collection}.{rel.source_field}</span>
                <ArrowRight size={14} />
                <span>{rel.target_collection}{rel.target_field ? `.${rel.target_field}` : ''}</span>
              </div>
              {#if rel.junction_table}
                <p class="text-xs text-base-content/40 mt-0.5">Junction: {rel.junction_table}</p>
              {/if}
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class="badge badge-ghost badge-sm">{rel.on_delete}</span>
              <button
                onclick={() => deleteRelation(rel.id, rel.name)}
                class="btn btn-ghost btn-xs text-error"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
