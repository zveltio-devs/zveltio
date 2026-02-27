<script lang="ts">
  import { onMount } from 'svelte';
  import { collectionsApi } from '$lib/api.js';
  import { Plus, Table, Trash2, Settings, Loader2 } from '@lucide/svelte';
  import { base } from '$app/paths';

  let collections = $state<any[]>([]);
  let loading = $state(true);
  let creating = $state(false);
  let newCollectionName = $state('');
  let showCreateModal = $state(false);
  let fieldTypes = $state<any[]>([]);
  let newFields = $state([{ name: '', type: 'text', required: false }]);

  onMount(async () => {
    await loadCollections();
    const ft = await collectionsApi.fieldTypes();
    fieldTypes = ft.field_types;
  });

  async function loadCollections() {
    loading = true;
    try {
      const res = await collectionsApi.list();
      collections = res.collections;
    } finally {
      loading = false;
    }
  }

  function addField() {
    newFields = [...newFields, { name: '', type: 'text', required: false }];
  }

  function removeField(i: number) {
    newFields = newFields.filter((_, idx) => idx !== i);
  }

  async function createCollection() {
    if (!newCollectionName.trim() || newFields.some((f) => !f.name)) return;
    creating = true;
    try {
      await collectionsApi.create({
        name: newCollectionName,
        fields: newFields,
      });
      showCreateModal = false;
      newCollectionName = '';
      newFields = [{ name: '', type: 'text', required: false }];
      await loadCollections();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create collection');
    } finally {
      creating = false;
    }
  }

  async function deleteCollection(name: string) {
    if (!confirm(`Delete collection "${name}"? This cannot be undone.`)) return;
    try {
      await collectionsApi.delete(name);
      await loadCollections();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete collection');
    }
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Collections</h1>
      <p class="text-base-content/60 text-sm mt-1">Manage your data models</p>
    </div>
    <button class="btn btn-primary btn-sm" onclick={() => (showCreateModal = true)}>
      <Plus size={16} />
      New Collection
    </button>
  </div>

  {#if loading}
    <div class="flex justify-center py-12">
      <Loader2 size={32} class="animate-spin text-primary" />
    </div>
  {:else if collections.length === 0}
    <div class="card bg-base-200 text-center py-12">
      <Table size={48} class="mx-auto opacity-30 mb-4" />
      <h3 class="font-semibold">No collections yet</h3>
      <p class="text-sm text-base-content/60 mt-1">Create your first collection to get started</p>
      <button class="btn btn-primary btn-sm mt-4" onclick={() => (showCreateModal = true)}>
        Create Collection
      </button>
    </div>
  {:else}
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each collections as col}
        <div class="card bg-base-200 hover:bg-base-300 transition-colors">
          <div class="card-body p-4">
            <div class="flex items-start justify-between">
              <div class="flex items-center gap-2">
                <Table size={18} class="text-primary" />
                <div>
                  <h3 class="font-semibold">{col.display_name || col.name}</h3>
                  <p class="text-xs text-base-content/50">{col.name}</p>
                </div>
              </div>
              <div class="flex gap-1">
                <a href="{base}/collections/{col.name}" class="btn btn-ghost btn-xs">
                  <Settings size={14} />
                </a>
                <button
                  onclick={() => deleteCollection(col.name)}
                  class="btn btn-ghost btn-xs text-error"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <div class="mt-2">
              <span class="badge badge-outline badge-sm">
                {(typeof col.fields === 'string' ? JSON.parse(col.fields) : col.fields)?.length || 0} fields
              </span>
              <span class="badge badge-outline badge-sm ml-1">{col.route_group || 'private'}</span>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Create Modal -->
{#if showCreateModal}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-2xl">
      <h3 class="font-bold text-lg mb-4">Create Collection</h3>

      <div class="form-control mb-4">
        <label class="label" for="col-name">
          <span class="label-text">Collection name</span>
          <span class="label-text-alt text-base-content/50">lowercase, no spaces</span>
        </label>
        <input
          id="col-name"
          type="text"
          bind:value={newCollectionName}
          placeholder="e.g. products"
          class="input input-bordered"
          pattern="[a-z][a-z0-9_]*"
        />
      </div>

      <div class="space-y-2 mb-4">
        <div class="flex items-center justify-between">
          <label class="label-text font-medium">Fields</label>
          <button class="btn btn-ghost btn-xs" onclick={addField}>
            <Plus size={14} /> Add field
          </button>
        </div>

        {#each newFields as field, i}
          <div class="flex gap-2 items-center">
            <input
              type="text"
              bind:value={field.name}
              placeholder="field_name"
              class="input input-bordered input-sm flex-1"
              pattern="[a-z][a-z0-9_]*"
            />
            <select bind:value={field.type} class="select select-bordered select-sm">
              {#each fieldTypes as ft}
                <option value={ft.type}>{ft.label}</option>
              {/each}
            </select>
            <label class="flex items-center gap-1 text-xs">
              <input type="checkbox" bind:checked={field.required} class="checkbox checkbox-xs" />
              Req.
            </label>
            {#if newFields.length > 1}
              <button onclick={() => removeField(i)} class="btn btn-ghost btn-xs text-error">
                <Trash2 size={14} />
              </button>
            {/if}
          </div>
        {/each}
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={createCollection} disabled={creating}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
          Create
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
  </dialog>
{/if}
