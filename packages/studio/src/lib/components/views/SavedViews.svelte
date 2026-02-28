<script lang="ts">
  // SavedViews: saves/loads filter+sort presets in localStorage per collection.
  import { onMount } from 'svelte';
  import Bookmark from '@lucide/svelte/icons/bookmark.svelte';
  import Trash2 from '@lucide/svelte/icons/trash-2.svelte';
  import Plus from '@lucide/svelte/icons/plus.svelte';

  interface SavedView {
    id: string;
    name: string;
    filters: Record<string, any>;
    sort: string;
    sortDir: 'asc' | 'desc';
    createdAt: string;
  }

  interface Props {
    collection: string;
    currentFilters?: Record<string, any>;
    currentSort?: string;
    currentSortDir?: 'asc' | 'desc';
    onLoad: (view: SavedView) => void;
  }

  let {
    collection,
    currentFilters = {},
    currentSort = '',
    currentSortDir = 'asc',
    onLoad,
  }: Props = $props();

  let views = $state<SavedView[]>([]);
  let showSaveForm = $state(false);
  let newViewName = $state('');

  const storageKey = `zveltio_saved_views_${collection}`;

  onMount(() => {
    try {
      views = JSON.parse(localStorage.getItem(storageKey) || '[]');
    } catch {
      views = [];
    }
  });

  function save() {
    if (!newViewName.trim()) return;
    const view: SavedView = {
      id: Date.now().toString(),
      name: newViewName.trim(),
      filters: currentFilters,
      sort: currentSort,
      sortDir: currentSortDir,
      createdAt: new Date().toISOString(),
    };
    views = [...views, view];
    localStorage.setItem(storageKey, JSON.stringify(views));
    newViewName = '';
    showSaveForm = false;
  }

  function remove(id: string) {
    views = views.filter((v) => v.id !== id);
    localStorage.setItem(storageKey, JSON.stringify(views));
  }

  function load(view: SavedView) {
    onLoad(view);
  }
</script>

<div class="space-y-2">
  <div class="flex items-center justify-between">
    <h3 class="font-semibold text-sm flex items-center gap-1"><Bookmark size={14} /> Saved Views</h3>
    <button class="btn btn-xs btn-ghost gap-1" onclick={() => (showSaveForm = !showSaveForm)}>
      <Plus size={12} /> Save Current
    </button>
  </div>

  {#if showSaveForm}
    <div class="flex gap-2">
      <input
        type="text"
        class="input input-bordered input-xs flex-1"
        placeholder="View name..."
        bind:value={newViewName}
        onkeydown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') showSaveForm = false; }}
      />
      <button class="btn btn-xs btn-primary" onclick={save} disabled={!newViewName.trim()}>Save</button>
      <button class="btn btn-xs btn-ghost" onclick={() => (showSaveForm = false)}>Cancel</button>
    </div>
  {/if}

  {#if views.length === 0}
    <p class="text-xs opacity-40 text-center py-2">No saved views yet</p>
  {:else}
    <div class="space-y-1">
      {#each views as view}
        <div class="flex items-center justify-between border border-base-300 rounded px-2 py-1 hover:bg-base-200">
          <button class="text-sm flex-1 text-left truncate" onclick={() => load(view)}>
            <span class="font-medium">{view.name}</span>
            {#if view.sort}
              <span class="text-xs opacity-50 ml-1">· sorted by {view.sort}</span>
            {/if}
          </button>
          <button class="btn btn-ghost btn-xs text-error" onclick={() => remove(view.id)}>
            <Trash2 size={12} />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>
