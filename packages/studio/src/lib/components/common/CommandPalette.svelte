<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { api } from '$lib/api.js';
  import { m, i18n } from '$lib/i18n.svelte.js';
  import type { PaletteNavItem } from '$lib/nav-model.js';
  import { Search, Database } from '@lucide/svelte';
  import type { Component } from 'svelte';

  type PaletteItem = {
    label: string;
    href: string;
    icon: Component;
    group: string;
    sub?: string;
  };

  interface Props {
    open: boolean;
    onclose: () => void;
    /** Core + extension routes from `buildPaletteNavItems`. */
    navItems: PaletteNavItem[];
  }

  let { open, onclose, navItems }: Props = $props();

  let query = $state('');
  let selectedIdx = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let collectionItems = $state<PaletteItem[]>([]);
  let loading = $state(false);

  const _locale = $derived(i18n.locale);

  const staticNavItems = $derived.by(() => {
    void _locale;
    return navItems;
  });

  $effect(() => {
    if (open) {
      query = '';
      selectedIdx = 0;
      collectionItems = [];
      setTimeout(() => inputEl?.focus(), 50);
      loadCollections();
    }
  });

  async function loadCollections() {
    loading = true;
    try {
      const colRes = await api.get<{ collections: { name: string; display_name?: string }[] }>('/api/collections');
      const group = m['palette.group.collections']();
      collectionItems = (colRes.collections || []).slice(0, 30).map((c) => ({
        label: c.display_name || c.name,
        href: `${base}/collections/${c.name}`,
        icon: Database,
        group,
        sub: c.name,
      }));
    } catch {
      collectionItems = [];
    } finally {
      loading = false;
    }
  }

  const filtered = $derived.by(() => {
    void _locale;
    const q = query.toLowerCase().trim();
    const all: PaletteItem[] = [...staticNavItems, ...collectionItems];
    if (!q) return all.slice(0, 20);
    return all.filter((item) =>
      item.label.toLowerCase().includes(q)
      || item.group.toLowerCase().includes(q)
      || (item.sub?.toLowerCase().includes(q) ?? false),
    ).slice(0, 20);
  });

  $effect(() => {
    query;
    selectedIdx = 0;
  });

  function navigate(href: string) {
    goto(href);
    onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') { onclose(); return; }
    const items = filtered;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[selectedIdx]) navigate(items[selectedIdx].href);
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
  });
  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
  });

  function groupedItems(items: PaletteItem[]) {
    const groups: Record<string, PaletteItem[]> = {};
    for (const item of items) {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item);
    }
    return Object.entries(groups);
  }

  function noResultsMessage(q: string): string {
    return m['palette.noResults']({ query: q });
  }
</script>

{#if open}
  <button
    type="button"
    class="fixed inset-0 z-100 bg-black/50 backdrop-blur-sm cursor-default"
    aria-label={m['palette.hint.close']()}
    onclick={onclose}
  ></button>

  <div
    class="fixed left-1/2 top-[20%] z-101 w-full max-w-xl -translate-x-1/2 rounded-2xl border border-base-300 bg-base-100 shadow-2xl overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-label={m['shell.search']()}
  >
    <div class="flex items-center gap-3 border-b border-base-200 px-4 py-3">
      <Search size={18} class="shrink-0 text-base-content/40" aria-hidden="true" />
      <input
        bind:this={inputEl}
        bind:value={query}
        type="search"
        placeholder={m['palette.placeholder']()}
        class="flex-1 bg-transparent text-sm outline-none placeholder:text-base-content/30"
      />
      {#if loading}
        <span class="loading loading-spinner loading-xs text-base-content/30" aria-hidden="true"></span>
      {:else}
        <kbd class="kbd kbd-sm text-base-content/30">Esc</kbd>
      {/if}
    </div>

    <div class="max-h-80 overflow-y-auto py-2">
      {#if filtered.length === 0}
        <p class="px-4 py-6 text-center text-sm text-base-content/40">{noResultsMessage(query)}</p>
      {:else}
        {@const items = filtered}
        {@const groups = groupedItems(items)}
        {#each groups as [groupName, groupItems] (groupName)}
          <p class="px-4 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-base-content/30">{groupName}</p>
          {#each groupItems as item (item.href + item.label)}
            {@const idx = items.indexOf(item)}
            <button
              type="button"
              class="w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left {idx === selectedIdx ? 'bg-primary/10 text-primary' : 'hover:bg-base-200'}"
              onclick={() => navigate(item.href)}
            >
              <item.icon size={16} class="shrink-0 opacity-60" aria-hidden="true" />
              <div class="flex-1 min-w-0">
                <span class="text-sm font-medium">{item.label}</span>
                {#if item.sub}
                  <span class="ml-2 text-xs text-base-content/40 font-mono">{item.sub}</span>
                {/if}
              </div>
            </button>
          {/each}
        {/each}
      {/if}
    </div>

    <div class="border-t border-base-200 px-4 py-2 flex items-center gap-4 text-xs text-base-content/30">
      <span><kbd class="kbd kbd-xs">↑↓</kbd> {m['palette.hint.navigate']()}</span>
      <span><kbd class="kbd kbd-xs">↵</kbd> {m['palette.hint.open']()}</span>
      <span><kbd class="kbd kbd-xs">Esc</kbd> {m['palette.hint.close']()}</span>
    </div>
  </div>
{/if}
