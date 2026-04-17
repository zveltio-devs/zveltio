<script lang="ts">
  import { onMount } from 'svelte';
  import { collectionsApi } from '$lib/api.js';
  import { Plus, Table, Trash2, Settings, LoaderCircle, Database } from '@lucide/svelte';
  import { base } from '$app/paths';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import EmptyState from '$lib/components/common/EmptyState.svelte';
  import SearchBar from '$lib/components/common/SearchBar.svelte';

  let collections = $state<any[]>([]);
  let loading = $state(true);
  let creating = $state(false);
  let newCollectionName = $state('');
  let nameError = $state('');
  let showCreateModal = $state(false);

  type NewField = {
    name: string;
    type: string;
    required: boolean;
    related_collection?: string;
    enum_values_raw?: string;
  };
  let newFields = $state<NewField[]>([{ name: '', type: 'text', required: false }]);
  let fieldTypes = $state<any[]>([]);
  let allCollections = $state<any[]>([]);
  let search = $state('');

  const RELATION_NEEDS_TARGET = new Set(['m2o', 'reference', 'o2m', 'm2m']);

  const categories = [
    { id: 'text', label: 'Text' },
    { id: 'number', label: 'Number' },
    { id: 'date', label: 'Date & Time' },
    { id: 'media', label: 'Media' },
    { id: 'relation', label: 'Relations' },
    { id: 'location', label: 'Location' },
    { id: 'special', label: 'Special' },
  ];

  function getCategoryTypes(category: string) {
    return fieldTypes.filter((t) => t.category === category);
  }

  function parseEnumValues(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

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
    try {
      const typesRes = await collectionsApi.fieldTypes();
      fieldTypes = typesRes.field_types ?? [];
    } catch { /* non-fatal */ }
    await loadCollections();
  });

  async function loadCollections() {
    loading = true;
    try {
      const res = await collectionsApi.list();
      collections = res.collections;
      allCollections = res.collections ?? [];
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
    for (const f of newFields) {
      if (RELATION_NEEDS_TARGET.has(f.type) && !f.related_collection) {
        nameError = `Field "${f.name}": select a target collection`;
        return;
      }
      if (f.type === 'enum' && parseEnumValues(f.enum_values_raw).length === 0) {
        nameError = `Field "${f.name}": add at least one enum value`;
        return;
      }
    }
    creating = true;
    try {
      const payloadFields = newFields.map((f) => {
        const options: Record<string, any> = {};
        if (RELATION_NEEDS_TARGET.has(f.type) && f.related_collection) {
          options.related_collection = f.related_collection;
        }
        if (f.type === 'enum') {
          const values = parseEnumValues(f.enum_values_raw);
          if (values.length > 0) options.values = values;
        }
        const body: Record<string, any> = { name: f.name.trim(), type: f.type, required: f.required };
        if (Object.keys(options).length > 0) body.options = options;
        return body;
      });
      await collectionsApi.create({ name: newCollectionName.trim(), fields: payloadFields });
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
    confirmState = {
      open: true,
      title: 'Delete Collection',
      message: `Delete collection "${name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      onconfirm: async () => {
        confirmState.open = false;
        try {
          await collectionsApi.delete(name);
          await loadCollections();
        } catch (err: any) {
          toast.error(err?.message ?? 'Failed to delete collection');
        }
      },
    };
  }

  function fieldCount(col: any): number {
    const f = typeof col.fields === 'string' ? JSON.parse(col.fields) : col.fields;
    return f?.length ?? 0;
  }

  const TEMPLATES = [
    {
      id: 'blog',
      label: 'Blog Posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'content', type: 'richtext', required: false },
        { name: 'slug', type: 'text', required: false },
        { name: 'status', type: 'text', required: false },
        { name: 'published_at', type: 'datetime', required: false },
      ],
    },
    {
      id: 'products',
      label: 'Products',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'price', type: 'number', required: false },
        { name: 'description', type: 'text', required: false },
        { name: 'status', type: 'text', required: false },
      ],
    },
    {
      id: 'team',
      label: 'Team Members',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'email', type: 'email', required: true },
        { name: 'role', type: 'text', required: false },
        { name: 'department', type: 'text', required: false },
      ],
    },
    {
      id: 'orders',
      label: 'Orders',
      fields: [
        { name: 'order_number', type: 'text', required: true },
        { name: 'customer_name', type: 'text', required: true },
        { name: 'amount', type: 'number', required: true },
        { name: 'status', type: 'text', required: false },
      ],
    },
    {
      id: 'events',
      label: 'Events',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'description', type: 'text', required: false },
        { name: 'start_date', type: 'datetime', required: true },
        { name: 'location', type: 'text', required: false },
      ],
    },
  ];

  let selectedTemplate = $state<string | null>(null);

  function applyTemplate(tmpl: typeof TEMPLATES[0]) {
    selectedTemplate = tmpl.id;
    newFields = tmpl.fields.map(f => ({ ...f }));
    if (!newCollectionName) {
      newCollectionName = tmpl.id;
      nameError = validateName(tmpl.id);
    }
  }

  function clearTemplate() {
    selectedTemplate = null;
    newFields = [{ name: '', type: 'text', required: false }];
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <PageHeader title="Collections" subtitle="Define and manage your data models" count={collections.length}>
    <button class="btn btn-primary btn-sm" onclick={() => { showCreateModal = true; nameError = ''; }}>
      <Plus size={16} />
      New Collection
    </button>
  </PageHeader>

  <!-- Search -->
  {#if collections.length > 4}
    <SearchBar value={search} onchange={(v: string) => search = v} placeholder="Search collections..." />
  {/if}

  {#if loading}
    <div class="flex justify-center py-16">
      <LoaderCircle size={28} class="animate-spin text-primary" />
    </div>
  {:else if collections.length === 0}
    <EmptyState
      icon={Database}
      title="No collections yet"
      description="Collections are database tables. Create one to start storing and managing data."
      actionLabel="Create your first collection"
      onaction={() => showCreateModal = true}
    />
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

      <!-- Template picker -->
      <div class="mb-5">
        <p class="text-sm font-medium mb-2">Start from a template</p>
        <div class="grid grid-cols-3 gap-2">
          {#each TEMPLATES as tmpl}
            <button
              type="button"
              class="border rounded-lg p-2.5 text-left transition-all
                     {selectedTemplate === tmpl.id
                       ? 'border-primary bg-primary/5'
                       : 'border-base-300 hover:border-primary/40'}"
              onclick={() => applyTemplate(tmpl)}
            >
              <div class="font-medium text-xs">{tmpl.label}</div>
              <div class="text-base-content/40 text-[10px] mt-0.5">{tmpl.fields.length} fields</div>
            </button>
          {/each}
          <button
            type="button"
            class="border rounded-lg p-2.5 text-left transition-all
                   {selectedTemplate === null
                     ? 'border-primary bg-primary/5'
                     : 'border-base-300 hover:border-primary/40'}"
            onclick={clearTemplate}
          >
            <div class="font-medium text-xs">Blank</div>
            <div class="text-base-content/40 text-[10px] mt-0.5">Start empty</div>
          </button>
        </div>
      </div>

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
          <div class="border border-base-300 rounded-lg p-3 space-y-2">
            <div class="flex gap-2 items-center">
              <input
                type="text"
                bind:value={field.name}
                placeholder="field_name"
                class="input input-sm flex-1 font-mono"
                pattern="[a-z][a-z0-9_]*"
              />
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
            <div class="space-y-1.5">
              {#each categories as cat}
                {@const types = getCategoryTypes(cat.id)}
                {#if types.length > 0}
                  <div>
                    <p class="text-[10px] uppercase tracking-wide text-base-content/40 mb-1">{cat.label}</p>
                    <div class="flex flex-wrap gap-1">
                      {#each types as t}
                        <button type="button"
                          class="badge cursor-pointer transition-all {field.type === t.id ? 'badge-primary' : 'badge-ghost hover:badge-outline'}"
                          title={t.description ?? t.id}
                          onclick={() => { field.type = t.id; }}>
                          {t.id}
                        </button>
                      {/each}
                    </div>
                  </div>
                {/if}
              {/each}
            </div>

            {#if RELATION_NEEDS_TARGET.has(field.type)}
              <div class="form-control">
                <label class="label py-1" for="rel-target-{i}">
                  <span class="label-text text-xs">Target collection <span class="text-error">*</span></span>
                </label>
                <select
                  id="rel-target-{i}"
                  class="select select-sm select-bordered"
                  bind:value={field.related_collection}
                >
                  <option value="">Select a collection…</option>
                  {#each allCollections as c}
                    <option value={c.name}>{c.display_name || c.name}</option>
                  {/each}
                </select>
              </div>
            {/if}

            {#if field.type === 'enum'}
              <div class="form-control">
                <label class="label py-1" for="enum-vals-{i}">
                  <span class="label-text text-xs">Allowed values <span class="text-error">*</span></span>
                  <span class="label-text-alt text-base-content/50 text-[10px]">comma or newline separated</span>
                </label>
                <textarea
                  id="enum-vals-{i}"
                  class="textarea textarea-sm textarea-bordered font-mono"
                  rows="2"
                  placeholder="active, pending, archived"
                  bind:value={field.enum_values_raw}
                ></textarea>
              </div>
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

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
