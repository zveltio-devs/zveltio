<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { collectionsApi, api } from '$lib/api.js';
  import { Plus, Trash2, GripVertical } from '@lucide/svelte';
  import { base } from '$app/paths';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import Breadcrumb from '$lib/components/common/Breadcrumb.svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import CollectionTabs from '$lib/components/common/CollectionTabs.svelte';
  import AddFieldDrawer from '$lib/components/fields/AddFieldDrawer.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  const collectionName = $derived(page.params.name ?? '');
  let collection = $state<any>(null);
  const isSystem = $derived(Boolean(collection?.is_system));
  const isReadonly = $derived(Boolean(collection?.readonly));
  let fieldTypes = $state<any[]>([]);
  let allCollections = $state<any[]>([]);
  let loading = $state(true);
  let drawerOpen = $state(false);

  let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

  onMount(async () => {
    try {
      const [colRes, typesRes, colsRes] = await Promise.all([
        collectionsApi.get(collectionName),
        collectionsApi.fieldTypes(),
        collectionsApi.list(),
      ]);
      collection = colRes.collection;
      fieldTypes = typesRes.field_types;
      allCollections = (colsRes.collections ?? []).filter((c: any) => c.name !== collectionName);
    } catch (e: any) {
      toast.error(e.message || 'Failed to load fields');
    } finally {
      loading = false;
    }
  });

  function getFields(): any[] {
    if (!collection) return [];
    const f = collection.fields;
    return typeof f === 'string' ? JSON.parse(f) : f || [];
  }

  async function handleAddField(body: Record<string, any>) {
    const existing = getFields().find((f: any) => f.name === body.name);
    if (existing) throw new Error(`Field '${body.name}' already exists`);
    await api.post(`/api/collections/${collectionName}/fields`, body);
    const res = await collectionsApi.get(collectionName);
    collection = res.collection;
  }

  async function deleteField(fieldName: string) {
    confirmState = {
      open: true,
      title: 'Delete Field',
      message: `Delete field '${fieldName}'? This will DROP the column and all its data.`,
      confirmLabel: 'Drop Field',
      onconfirm: async () => {
        confirmState.open = false;
        try {
          await api.delete(`/api/collections/${collectionName}/fields/${fieldName}`);
          const res = await collectionsApi.get(collectionName);
          collection = res.collection;
        } catch (err: any) {
          toast.error(err.message);
        }
      },
    };
  }
</script>

<div class="space-y-6">
  <Breadcrumb crumbs={[
    { label: 'Collections', href: `${base}/collections` },
    { label: collection?.display_name || collectionName, href: `${base}/collections/${collectionName}` },
    { label: 'Fields' },
  ]} />

  <PageHeader
    title="{collection?.display_name || collectionName} / Fields"
    subtitle={isSystem ? 'Read-only schema managed by the engine' : 'Manage the schema for this collection'}
  >
    {#if !isSystem && !isReadonly}
      <button class="btn btn-primary btn-sm" onclick={() => (drawerOpen = true)}>
        <Plus size={16} /> Add Field
      </button>
    {/if}
  </PageHeader>

  <CollectionTabs {collectionName} active="fields" />

  {#if loading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else}
    <div class="grid lg:grid-cols-3 gap-4">
      <!-- Left: fields list (2/3) -->
      <div class="lg:col-span-2 space-y-4">
        <div class="space-y-2">
          <h2 class="text-sm font-semibold text-base-content/60 uppercase tracking-wider">
            Custom Fields ({getFields().length})
          </h2>

          {#each getFields() as field}
            <div class="card bg-base-200 hover:bg-base-300 transition-colors">
              <div class="card-body p-4 flex-row items-center gap-4">
                <GripVertical size={16} class="text-base-content/20 cursor-grab shrink-0" />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-mono font-semibold">{field.name}</span>
                    {#if field.label && field.label !== field.name}
                      <span class="text-base-content/50 text-sm">{field.label}</span>
                    {/if}
                    <span class="badge badge-outline badge-sm">{field.type}</span>
                    {#if field.required}<span class="badge badge-warning badge-sm">required</span>{/if}
                    {#if field.unique}<span class="badge badge-info badge-sm">unique</span>{/if}
                    {#if field.indexed}<span class="badge badge-ghost badge-sm">indexed</span>{/if}
                  </div>
                  {#if field.description}
                    <p class="text-xs text-base-content/50 mt-0.5">{field.description}</p>
                  {/if}
                </div>
                <button
                  onclick={() => deleteField(field.name)}
                  class="btn btn-ghost btn-xs text-error shrink-0"
                  title="Delete field"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          {/each}

          {#if getFields().length === 0}
            <div class="text-center py-12 text-base-content/40">
              <p class="text-sm">No custom fields yet.</p>
              {#if !isSystem && !isReadonly}
                <button class="btn btn-outline btn-sm mt-3" onclick={() => (drawerOpen = true)}>
                  <Plus size={14} /> Add your first field
                </button>
              {/if}
            </div>
          {/if}
        </div>

        {#if !isSystem}
          <div class="space-y-2">
            <h2 class="text-sm font-semibold text-base-content/60 uppercase tracking-wider">
              System Fields (auto-managed)
            </h2>
            <div class="overflow-x-auto">
              <table class="table table-sm opacity-60">
                <thead>
                  <tr><th>Name</th><th>Type</th><th>Notes</th></tr>
                </thead>
                <tbody>
                  {#each [
                    { name: 'id', type: 'UUID', notes: 'Primary key, auto-generated' },
                    { name: 'created_at', type: 'TIMESTAMPTZ', notes: 'Set on insert' },
                    { name: 'updated_at', type: 'TIMESTAMPTZ', notes: 'Updated on every save' },
                    { name: 'status', type: 'TEXT', notes: "Default: 'active' (active | draft | archived)" },
                    { name: 'created_by', type: 'TEXT', notes: 'User ID who created' },
                    { name: 'updated_by', type: 'TEXT', notes: 'User ID who last updated' },
                  ] as sys}
                    <tr>
                      <td><code>{sys.name}</code></td>
                      <td class="font-mono text-xs">{sys.type}</td>
                      <td class="text-xs text-base-content/50">{sys.notes}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      </div>

      <!-- Right: Schema Preview (1/3) -->
      <div class="lg:col-span-1">
        <div class="border border-base-200 rounded-xl bg-base-100 overflow-hidden sticky top-4">
          <div class="px-4 py-3 border-b border-base-200">
            <h2 class="text-sm font-medium text-base-content">Schema Preview</h2>
          </div>
          <div class="p-3 font-mono text-xs text-base-content/60 overflow-auto max-h-96">
            <pre>{JSON.stringify(getFields().map((f: any) => ({ name: f.name, type: f.type, required: !!f.required })), null, 2)}</pre>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<AddFieldDrawer
  bind:open={drawerOpen}
  {fieldTypes}
  {allCollections}
  {collectionName}
  onsave={handleAddField}
/>

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel ?? 'Confirm'}
  onconfirm={confirmState.onconfirm}
  oncancel={() => (confirmState.open = false)}
/>
