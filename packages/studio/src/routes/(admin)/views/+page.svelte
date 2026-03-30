<script lang="ts">
  import { onMount } from 'svelte';
  import { api, collectionsApi } from '$lib/api.js';
  import { base } from '$app/paths';
  import {
    Plus, Trash2, Layout, LayoutGrid, Table2, Columns3, CalendarDays,
    GalleryHorizontal, BarChart2, Map, List, Clock, Search,
    LoaderCircle, Database,
  } from '@lucide/svelte';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { toast } from '$lib/stores/toast.svelte.js';

  let views = $state<any[]>([]);
  let collections = $state<any[]>([]);
  let loading = $state(true);
  let showModal = $state(false);
  let creating = $state(false);
  let searchQuery = $state('');
  let confirmState = $state<{ open: boolean; title: string; message: string; confirmLabel?: string; onconfirm: () => void }>({ open: false, title: '', message: '', onconfirm: () => {} });

  let form = $state({
    name: '',
    description: '',
    collection: '',
    view_type: 'table',
    page_size: 20,
  });

  const VIEW_TYPES = [
    { value: 'table',    label: 'Table',    icon: Table2 },
    { value: 'kanban',   label: 'Kanban',   icon: Columns3 },
    { value: 'calendar', label: 'Calendar', icon: CalendarDays },
    { value: 'gallery',  label: 'Gallery',  icon: GalleryHorizontal },
    { value: 'stats',    label: 'Stats',    icon: BarChart2 },
    { value: 'chart',    label: 'Chart',    icon: BarChart2 },
    { value: 'list',     label: 'List',     icon: List },
    { value: 'timeline', label: 'Timeline', icon: Clock },
  ];

  const filtered = $derived(
    searchQuery.trim()
      ? views.filter(v =>
          v.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          v.collection.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : views
  );

  onMount(async () => {
    await Promise.all([loadViews(), loadCollections()]);
  });

  async function loadViews() {
    loading = true;
    try {
      const res = await api.get<{ views: any[]; total: number }>('/api/views?limit=200');
      views = res.views ?? [];
    } catch {
      views = [];
    } finally {
      loading = false;
    }
  }

  async function loadCollections() {
    try {
      const res = await collectionsApi.list();
      collections = (res.collections ?? []).filter((c: any) => !c.is_system);
    } catch {
      collections = [];
    }
  }

  async function createView() {
    if (!form.name.trim() || !form.collection) return;
    creating = true;
    try {
      await api.post('/api/views', {
        name: form.name.trim(),
        description: form.description || undefined,
        collection: form.collection,
        view_type: form.view_type,
        page_size: form.page_size,
      });
      showModal = false;
      form = { name: '', description: '', collection: '', view_type: 'table', page_size: 20 };
      await loadViews();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to create view');
    } finally {
      creating = false;
    }
  }

  async function deleteView(id: string, name: string) {
    confirmState = {
      open: true,
      title: 'Delete View',
      message: `Delete view "${name}"? It will be removed from all pages.`,
      confirmLabel: 'Delete',
      onconfirm: async () => {
        confirmState.open = false;
        try {
          await api.delete(`/api/views/${id}`);
          views = views.filter(v => v.id !== id);
        } catch (e: any) {
          toast.error(e.message ?? 'Failed to delete view');
        }
      },
    };
  }

  function viewTypeIcon(type: string) {
    return VIEW_TYPES.find(t => t.value === type)?.icon ?? Layout;
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between flex-wrap gap-4">
    <div>
      <h1 class="text-2xl font-bold">Views</h1>
      <p class="text-base-content/60 text-sm mt-0.5">Reusable data views — assign them to pages in any zone</p>
    </div>
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
      <Plus size={15}/> New View
    </button>
  </div>

  <!-- Search -->
  {#if views.length > 4}
    <label class="input input-sm w-64 flex items-center gap-2">
      <Search size={14} class="text-base-content/40"/>
      <input type="text" placeholder="Filter views…" bind:value={searchQuery} class="grow"/>
    </label>
  {/if}

  {#if loading}
    <div class="flex justify-center py-16">
      <LoaderCircle size={28} class="animate-spin text-primary"/>
    </div>
  {:else if views.length === 0}
    <div class="flex flex-col items-center justify-center py-20 text-base-content/40 gap-3">
      <LayoutGrid size={48} class="opacity-20" />
      <p class="text-lg font-semibold text-base-content/60">No views yet</p>
      <p class="text-sm text-center max-w-sm">Views let you display collection data in different layouts.</p>
      <button class="btn btn-primary btn-sm mt-2" onclick={() => (showModal = true)}>Create View</button>
    </div>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {#each filtered as v (v.id)}
        {@const TypeIcon = viewTypeIcon(v.view_type)}
        <div class="group card bg-base-200 hover:bg-base-300 transition-colors border border-transparent hover:border-base-300">
          <div class="card-body p-4 gap-3">
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <div class="p-1.5 rounded-lg bg-primary/10 shrink-0">
                  <TypeIcon size={14} class="text-primary"/>
                </div>
                <div class="min-w-0">
                  <h3 class="font-semibold text-sm truncate">{v.name}</h3>
                  <p class="text-xs text-base-content/40 font-mono truncate">{v.collection}</p>
                </div>
              </div>
              <button
                class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onclick={() => deleteView(v.id, v.name)}
                title="Delete"
              >
                <Trash2 size={13}/>
              </button>
            </div>

            <div class="flex gap-1.5 flex-wrap">
              <span class="badge badge-outline badge-xs capitalize">{v.view_type}</span>
              <span class="badge badge-ghost badge-xs">{v.page_size ?? 20} / page</span>
              {#if v.is_public}
                <span class="badge badge-success badge-xs">public</span>
              {/if}
            </div>

            {#if v.description}
              <p class="text-xs text-base-content/50 line-clamp-2">{v.description}</p>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    {#if searchQuery && filtered.length === 0}
      <p class="text-center text-sm text-base-content/40 py-8">No views match "{searchQuery}"</p>
    {/if}
  {/if}
</div>

<!-- Create Modal -->
{#if showModal}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">New View</h3>

      <div class="form-control mb-3">
        <label class="label" for="vn"><span class="label-text">Name *</span></label>
        <input id="vn" type="text" class="input" placeholder="e.g. Recent Orders"
          bind:value={form.name}/>
      </div>

      <div class="form-control mb-3">
        <label class="label" for="vc"><span class="label-text">Collection *</span></label>
        <select id="vc" class="select" bind:value={form.collection}>
          <option value="">Select collection…</option>
          {#each collections as col}
            <option value={col.name}>{col.display_name || col.name}</option>
          {/each}
        </select>
      </div>

      <div class="mb-3">
        <p class="label-text text-sm font-medium mb-2">View type</p>
        <div class="grid grid-cols-4 gap-2">
          {#each VIEW_TYPES as vt}
            {@const VIcon = vt.icon}
            <button
              class="flex flex-col items-center gap-1 p-2 rounded-lg border-2 text-xs transition-all
                     {form.view_type === vt.value ? 'border-primary bg-primary/5 text-primary' : 'border-base-300 bg-base-200 hover:border-primary/40'}"
              onclick={() => (form.view_type = vt.value)}
            >
              <VIcon size={18}/>
              {vt.label}
            </button>
          {/each}
        </div>
      </div>

      <div class="form-control mb-3">
        <label class="label" for="vps"><span class="label-text">Rows per page</span></label>
        <input id="vps" type="number" class="input" min="5" max="200" bind:value={form.page_size}/>
      </div>

      <div class="form-control mb-4">
        <label class="label" for="vdesc"><span class="label-text">Description</span></label>
        <textarea id="vdesc" class="textarea" rows={2} placeholder="Optional description…"
          bind:value={form.description}></textarea>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => { showModal = false; }}>Cancel</button>
        <button
          class="btn btn-primary gap-1"
          onclick={createView}
          disabled={!form.name.trim() || !form.collection || creating}
        >
          {#if creating}<LoaderCircle size={15} class="animate-spin"/>{/if}
          Create View
        </button>
      </div>
    </div>
    <div class="modal-backdrop" role="button" tabindex="0" aria-label="Close"
      onclick={() => { showModal = false; }}
      onkeydown={(e) => { if (e.key === 'Escape') { showModal = false; } }}></div>
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
