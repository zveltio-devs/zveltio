<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { api } from '$lib/api.js';
  import { Search, Database, Users, Webhook, Bot, Puzzle, Shield, Workflow, Layout, LayoutGrid, Settings, FileText, Key } from '@lucide/svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  let query = $state('');
  let selectedIdx = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);

  // Static nav items
  const navItems = [
    { label: 'Collections', href: `${base}/collections`, icon: Database, group: 'Navigation' },
    { label: 'Users', href: `${base}/users`, icon: Users, group: 'Navigation' },
    { label: 'Permissions', href: `${base}/permissions`, icon: Shield, group: 'Navigation' },
    { label: 'Webhooks', href: `${base}/webhooks`, icon: Webhook, group: 'Navigation' },
    { label: 'AI Hub', href: `${base}/ai`, icon: Bot, group: 'Navigation' },
    { label: 'Extensions / Marketplace', href: `${base}/marketplace`, icon: Puzzle, group: 'Navigation' },
    { label: 'Edge Functions', href: `${base}/edge-functions`, icon: FileText, group: 'Navigation' },
    { label: 'Flows', href: `${base}/flows`, icon: Workflow, group: 'Navigation' },
    { label: 'Zones', href: `${base}/zones`, icon: Layout, group: 'Navigation' },
    { label: 'Views', href: `${base}/views`, icon: LayoutGrid, group: 'Navigation' },
    { label: 'API Keys', href: `${base}/api-keys`, icon: Key, group: 'Navigation' },
    { label: 'Settings', href: `${base}/settings`, icon: Settings, group: 'Navigation' },
  ];

  let dynamicItems = $state<Array<{ label: string; href: string; icon: any; group: string; sub?: string }>>([]);
  let loading = $state(false);

  $effect(() => {
    if (open) {
      query = '';
      selectedIdx = 0;
      dynamicItems = [];
      setTimeout(() => inputEl?.focus(), 50);
      loadDynamic();
    }
  });

  async function loadDynamic() {
    loading = true;
    try {
      const [colRes] = await Promise.allSettled([
        api.get<{ collections: any[] }>('/api/collections'),
      ]);
      const items: typeof dynamicItems = [];
      if (colRes.status === 'fulfilled') {
        for (const c of (colRes.value.collections || []).slice(0, 30)) {
          items.push({ label: c.display_name || c.name, href: `${base}/collections/${c.name}`, icon: Database, group: 'Collections', sub: c.name });
        }
      }
      dynamicItems = items;
    } finally {
      loading = false;
    }
  }

  const filtered = $derived(() => {
    const q = query.toLowerCase().trim();
    const all = [...navItems, ...dynamicItems];
    if (!q) return all.slice(0, 12);
    return all.filter(item =>
      item.label.toLowerCase().includes(q) ||
      item.group.toLowerCase().includes(q) ||
      ('sub' in item && item.sub && item.sub.toLowerCase().includes(q))
    ).slice(0, 12);
  });

  $effect(() => {
    selectedIdx = 0;
  });

  function navigate(href: string) {
    goto(href);
    onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') { onclose(); return; }
    const items = filtered();
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

  function groupedItems(items: typeof dynamicItems) {
    const groups: Record<string, typeof dynamicItems> = {};
    for (const item of items) {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item);
    }
    return Object.entries(groups);
  }
</script>

{#if open}
  <!-- Backdrop -->
  <div class="fixed inset-0 z-100 bg-black/50 backdrop-blur-sm" role="button" tabindex="0" onclick={onclose} onkeydown={(e) => e.key === 'Enter' || e.key === ' ' ? (onclose(), false) : null}></div>

  <!-- Palette -->
  <div class="fixed left-1/2 top-[20%] z-101 w-full max-w-xl -translate-x-1/2 rounded-2xl border border-base-300 bg-base-100 shadow-2xl overflow-hidden">
    <!-- Search input -->
    <div class="flex items-center gap-3 border-b border-base-200 px-4 py-3">
      <Search size={18} class="shrink-0 text-base-content/40" />
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        placeholder="Search pages, collections…"
        class="flex-1 bg-transparent text-sm outline-none placeholder:text-base-content/30"
      />
      {#if loading}
        <span class="loading loading-spinner loading-xs text-base-content/30"></span>
      {:else}
        <kbd class="kbd kbd-sm text-base-content/30">Esc</kbd>
      {/if}
    </div>

    <!-- Results -->
    <div class="max-h-80 overflow-y-auto py-2">
      {#if filtered().length === 0}
        <p class="px-4 py-6 text-center text-sm text-base-content/40">No results for "{query}"</p>
      {:else}
        {@const items = filtered()}
        {@const groups = groupedItems(items)}
        {#each groups as [groupName, groupItems]}
          <p class="px-4 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-base-content/30">{groupName}</p>
          {#each groupItems as item}
            {@const idx = items.indexOf(item)}
            <div
              role="button"
              tabindex="0"
              class="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors {idx === selectedIdx ? 'bg-primary/10 text-primary' : 'hover:bg-base-200'}"
              onclick={() => navigate(item.href)}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate(item.href);
                }
              }}
            >
              <item.icon size={16} class="shrink-0 opacity-60" />
              <div class="flex-1 min-w-0">
                <span class="text-sm font-medium">{item.label}</span>
                {#if item.sub}
                  <span class="ml-2 text-xs text-base-content/40 font-mono">{item.sub}</span>
                {/if}
              </div>
            </div>
          {/each}
        {/each}
      {/if}
    </div>

    <!-- Footer hint -->
    <div class="border-t border-base-200 px-4 py-2 flex items-center gap-4 text-xs text-base-content/30">
      <span><kbd class="kbd kbd-xs">↑↓</kbd> navigate</span>
      <span><kbd class="kbd kbd-xs">↵</kbd> open</span>
      <span><kbd class="kbd kbd-xs">Esc</kbd> close</span>
    </div>
  </div>
{/if}
