<script lang="ts">
  import { onMount } from 'svelte';
  import { collectionsApi } from '$lib/api.js';
  import { Plus, Table, Trash2, Settings, LoaderCircle, Database, Search } from '@lucide/svelte';
  import { base } from '$app/paths';

  let collections = $state<any[]>([]);
  let loading = $state(true);
  let creating = $state(false);
  let newCollectionName = $state('');
  let nameError = $state('');
  let showCreateModal = $state(false);
  let fieldTypes = $state<any[]>([]);
  let newFields = $state([{ name: '', type: 'text', required: false }]);
  let search = $state('');

  const filtered = $derived(
    search.trim()
      ? collections.filter(
          (c) =>
            c.name.includes(search.toLowerCase()) ||
            (c.display_name ?? '').toLowerCase().includes(search.toLowerCase()),
        )
      : collections,
  );

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

  function validateName(name: string): string {
    if (!name) return 'Name is required';
    if (!/^[a-z][a-z0-9_]*$/.test(name)) return 'Use lowercase letters, digits, and underscores only (must start with a letter)';
    if (collections.some((c) => c.name === name)) return `A collection named "${name}" already exists`;
    return '';
  }

  async function createCollection() {
    nameError = validateName(newCollectionName.trim());
    if (nameError) return;
    if (newFields.some((f) => !f.name.trim())) {
      nameError = 'All fields must have a name';
      return;
    }
    creating = true;
    try {
      await collectionsApi.create({ name: newCollectionName.trim(), fields: newFields });
      showCreateModal = false;
      newCollectionName = '';
      newFields = [{ name: '', type: 'text', required: false }];
      nameError = '';
      await loadCollections();
    } catch (err: any) {
      nameError = err?.message ?? 'Failed to create collection';
    } finally {
      creating = false;
    }
  }

  async function deleteCollection(name: string) {
    if (!confirm(`Delete collection "${name}"? This cannot be undone.`)) return;
    try {
      await collectionsApi.delete(name);
      await loadCollections();
    } catch (err: any) {
      alert(err?.message ?? 'Failed to delete collection');
    }
  }

  function fieldCount(col: any): number {
    const f = typeof col.fields === 'string' ? JSON.parse(col.fields) : col.fields;
    return f?.length ?? 0;
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between gap-4 flex-wrap">
    <div>
      <h1 class="text-2xl font-bold">Collections</h1>
      <p class="text-base-content/60 text-sm mt-0.5">Define and manage your data models</p>
    </div>
    <button class="btn btn-primary btn-sm" onclick={() => { showCreateModal = true; nameError = ''; }}>
      <Plus size={16} />
      New Collection
    </button>
  </div>

  <!-- Search -->
  {#if collections.length > 4}
    <label class="input input-sm w-64 flex items-center gap-2">
      <Search size={14} class="text-base-content/40" />
      <input type="text" placeholder="Filter collections…" bind:value={search} class="grow" />
    </label>
  {/if}

  {#if loading}
    <div class="flex justify-center py-16">
      <LoaderCircle size={28} class="animate-spin text-primary" />
    </div>
  {:else if collections.length === 0}
    <div class="flex flex-col items-center justify-center py-20 text-center gap-3">
      <div class="p-4 rounded-2xl bg-base-200">
        <Database size={40} class="text-base-content/30" />
      </div>
      <h3 class="font-semibold text-base-content/70">No collections yet</h3>
      <p class="text-sm text-base-content/50 max-w-xs">
        Collections are the tables in your database. Create one to start storing data.
      </p>
      <button class="btn btn-primary btn-sm mt-1" onclick={() => (showCreateModal = true)}>
        Create your first collection
      </button>
    </div>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {#each filtered as col (col.name)}
        <div class="group card bg-base-200 hover:bg-base-300 transition-colors border border-transparent hover:border-base-300">
          <div class="card-body p-4 gap-3">
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <div class="p-1.5 rounded-lg bg-primary/10 shrink-0">
                  <Table size={14} class="text-primary" />
                </div>
                <div class="min-w-0">
                  <h3 class="font-semibold text-sm truncate">{col.display_name || col.name}</h3>
                  <p class="text-xs text-base-content/40 font-mono truncate">{col.name}</p>
                </div>
              </div>
              <div class="flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <a href="{base}/collections/{col.name}" class="btn btn-ghost btn-xs" title="Open">
                  <Settings size={13} />
                </a>
                {#if !col.is_system}
                  <button
                    onclick={() => deleteCollection(col.name)}
                    class="btn btn-ghost btn-xs text-error"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                {/if}
              </div>
            </div>
            <div class="flex gap-1.5 flex-wrap">
              <span class="badge badge-outline badge-xs">{fieldCount(col)} fields</span>
              {#if col.route_group}
                <span class="badge badge-ghost badge-xs">{col.route_group}</span>
              {/if}
              {#if col.is_system}
                <span class="badge badge-info badge-xs">system</span>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>

    {#if search && filtered.length === 0}
      <p class="text-center text-sm text-base-content/40 py-8">No collections match "{search}"</p>
    {/if}
  {/if}
</div>

<!-- Create Modal -->
{#if showCreateModal}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-2xl">
      <h3 class="font-bold text-lg mb-5">New Collection</h3>

      <div class="form-control mb-4">
        <label class="label" for="col-name">
          <span class="label-text font-medium">Collection name</span>
          <span class="label-text-alt text-base-content/40">lowercase, letters, digits, underscores</span>
        </label>
        <input
          id="col-name"
          type="text"
          bind:value={newCollectionName}
          oninput={() => { nameError = validateName(newCollectionName.trim()); }}
          placeholder="e.g. products"
          class="input {nameError ? 'input-error' : ''}"
          pattern="[a-z][a-z0-9_]*"
          autocomplete="off"
        />
        {#if nameError}
          <span class="label text-error text-xs mt-1">{nameError}</span>
        {/if}
      </div>

      <div class="space-y-2 mb-5">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">Fields</span>
          <button class="btn btn-ghost btn-xs" onclick={addField}>
            <Plus size={13} /> Add field
          </button>
        </div>

        {#each newFields as field, i}
          <div class="flex gap-2 items-center">
            <input
              type="text"
              bind:value={field.name}
              placeholder="field_name"
              class="input input-sm flex-1 font-mono"
              pattern="[a-z][a-z0-9_]*"
            />
            <select bind:value={field.type} class="select select-sm w-36">
              {#each fieldTypes as ft}
                <option value={ft.type}>{ft.label}</option>
              {/each}
            </select>
            <label class="flex items-center gap-1 text-xs whitespace-nowrap">
              <input type="checkbox" bind:checked={field.required} class="checkbox checkbox-xs" />
              Required
            </label>
            {#if newFields.length > 1}
              <button onclick={() => removeField(i)} class="btn btn-ghost btn-xs text-error">
                <Trash2 size={13} />
              </button>
            {/if}
          </div>
        {/each}
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => { showCreateModal = false; nameError = ''; }}>Cancel</button>
        <button class="btn btn-primary" onclick={createCollection} disabled={creating || !!nameError}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
          Create Collection
        </button>
      </div>
    </div>
    <button class="modal-backdrop" aria-label="Close" onclick={() => { showCreateModal = false; nameError = ''; }}></button>
  </dialog>
{/if}
