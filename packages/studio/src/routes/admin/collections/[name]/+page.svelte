<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { collectionsApi, dataApi } from '$lib/api.js';
  import { ArrowLeft, Plus, Trash2, RefreshCw } from '@lucide/svelte';
  import { base } from '$app/paths';

  const collectionName = $derived($page.params.name);
  let collection = $state<any>(null);
  let records = $state<any[]>([]);
  let pagination = $state<any>({ total: 0, page: 1, limit: 20 });
  let loading = $state(true);
  let activeTab = $state<'data' | 'schema'>('data');

  onMount(async () => {
    await load();
  });

  async function load() {
    loading = true;
    try {
      const [colRes, dataRes] = await Promise.all([
        collectionsApi.get(collectionName),
        dataApi.list(collectionName, { limit: '20' }),
      ]);
      collection = colRes.collection;
      records = dataRes.records;
      pagination = dataRes.pagination;
    } finally {
      loading = false;
    }
  }

  function getFields(): any[] {
    if (!collection) return [];
    const f = collection.fields;
    return typeof f === 'string' ? JSON.parse(f) : f || [];
  }

  async function deleteRecord(id: string) {
    if (!confirm('Delete this record?')) return;
    await dataApi.delete(collectionName, id);
    await load();
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center gap-3">
    <a href="{base}/collections" class="btn btn-ghost btn-sm">
      <ArrowLeft size={16} />
    </a>
    <div>
      <h1 class="text-2xl font-bold">{collection?.display_name || collectionName}</h1>
      <p class="text-base-content/60 text-sm">{collectionName}</p>
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs tabs-bordered">
    <button
      class="tab {activeTab === 'data' ? 'tab-active' : ''}"
      onclick={() => (activeTab = 'data')}
    >
      Data
    </button>
    <button
      class="tab {activeTab === 'schema' ? 'tab-active' : ''}"
      onclick={() => (activeTab = 'schema')}
    >
      Schema
    </button>
  </div>

  {#if activeTab === 'data'}
    <div class="flex justify-between items-center">
      <span class="text-sm text-base-content/60">{pagination.total} records</span>
      <button onclick={load} class="btn btn-ghost btn-sm">
        <RefreshCw size={14} />
      </button>
    </div>

    {#if loading}
      <div class="flex justify-center py-12">
        <span class="loading loading-spinner loading-lg"></span>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              {#each getFields().filter((f) => f.type !== 'computed') as field}
                <th>{field.label || field.name}</th>
              {/each}
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each records as record}
              <tr>
                {#each getFields().filter((f) => f.type !== 'computed') as field}
                  <td class="max-w-xs truncate">
                    {#if record[field.name] === null || record[field.name] === undefined}
                      <span class="text-base-content/30">—</span>
                    {:else if typeof record[field.name] === 'object'}
                      <code class="text-xs">{JSON.stringify(record[field.name])}</code>
                    {:else}
                      {record[field.name]}
                    {/if}
                  </td>
                {/each}
                <td class="text-xs text-base-content/50">
                  {new Date(record.created_at).toLocaleDateString()}
                </td>
                <td>
                  <button
                    onclick={() => deleteRecord(record.id)}
                    class="btn btn-ghost btn-xs text-error"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else}
    <!-- Schema tab -->
    <div class="space-y-3">
      {#each getFields() as field}
        <div class="card bg-base-200">
          <div class="card-body p-4">
            <div class="flex items-center justify-between">
              <div>
                <span class="font-mono font-semibold">{field.name}</span>
                {#if field.label && field.label !== field.name}
                  <span class="text-base-content/50 text-sm ml-2">({field.label})</span>
                {/if}
              </div>
              <div class="flex gap-2">
                <span class="badge badge-outline">{field.type}</span>
                {#if field.required}
                  <span class="badge badge-warning badge-sm">required</span>
                {/if}
                {#if field.unique}
                  <span class="badge badge-info badge-sm">unique</span>
                {/if}
              </div>
            </div>
          </div>
        </div>
      {/each}

      <!-- System fields -->
      <div class="divider text-xs">System fields (auto-managed)</div>
      {#each ['id', 'created_at', 'updated_at', 'status', 'created_by', 'updated_by'] as sysField}
        <div class="card bg-base-100 opacity-50">
          <div class="card-body p-3">
            <span class="font-mono text-sm">{sysField}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
