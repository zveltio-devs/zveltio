<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let {
    open = false,
    collections = [],
    users = []
  }: {
    open?: boolean;
    collections?: Array<{name: string, label?: string}>;
    users?: Array<{id: string, email: string, name?: string}>;
  } = $props();

  let query = $state('');
  let selectedIdx = $state(0);
  let isOpen = $state(false);
  let inputRef: HTMLInputElement | null = null;

  type SearchResult = {
    id: string;
    name: string;
    type: 'collection' | 'user';
    score: number;
  };

  let results = $state<SearchResult[]>([]);

  function fuzzyMatch(query: string, text: string): number {
    if (!query || !text) return 0;
    const lowerQuery = query.toLowerCase();
    const lowerText = text.toLowerCase();
    if (lowerText === lowerQuery) return 1;
    if (lowerText.startsWith(lowerQuery)) return 0.9;
    if (lowerText.includes(lowerQuery)) return 0.7;
    return 0.5;
  }

  function searchCollections(query: string, colls: Array<{name: string, label?: string}>): SearchResult[] {
    if (!query || query.length < 2) return [];
    return colls
      .map((col) => {
        const score = Math.max(fuzzyMatch(query, col.name), col.label ? fuzzyMatch(query, col.label) : 0);
        return { id: col.name, name: col.label || col.name, type: 'collection' as const, score };
      })
      .filter((item) => item.score > 0.3)
      .sort((a, b) => b.score - a.score);
  }

  function searchUsers(query: string, usrs: Array<{id: string, email: string, name?: string}>): SearchResult[] {
    if (!query || query.length < 2) return [];
    return usrs
      .map((user) => {
        const score = Math.max(fuzzyMatch(query, user.email), user.name ? fuzzyMatch(query, user.name) : 0);
        return { id: user.id, name: user.name || user.email, type: 'user' as const, score };
      })
      .filter((item) => item.score > 0.3)
      .sort((a, b) => b.score - a.score);
  }

  $effect(() => {
    if (!query || query.length < 1) {
      results = [];
      return;
    }
    const collResults = searchCollections(query, collections as any) as SearchResult[];
    const userResults = searchUsers(query, users as any) as SearchResult[];
    const combined = [...collResults, ...userResults];
    const uniqueResults = combined.filter((r, i, arr) => 
      arr.findIndex(x => x.id === r.id && x.type === r.type) === i
    );
    results = uniqueResults.slice(0, 10);
  });

  function close() {
    isOpen = false;
    query = '';
    selectedIdx = 0;
  }

  function navigateUp() {
    if (selectedIdx > 0) selectedIdx--;
  }

  function navigateDown() {
    if (selectedIdx < results.length - 1) selectedIdx++;
  }

  function selectItem() {
    if (results[selectedIdx]) {
      const result = results[selectedIdx];
      if (result.type === 'collection') goto(`/collections/${result.id}`);
      else if (result.type === 'user') goto(`/users/${result.id}`);
      close();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowUp') { e.preventDefault(); navigateUp(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); navigateDown(); }
    else if (e.key === 'Enter') { e.preventDefault(); selectItem(); }
    else if (e.key === 'Escape') { close(); }
  }

  function handleItemClick(e: MouseEvent) {
    e.preventDefault();
    selectItem();
  }

  onMount(() => {
    if (open) isOpen = true;
    
    // Focus input when modal opens using setTimeout for element to be available
    if (isOpen) {
      setTimeout(() => {
        const el = document.querySelector('input[placeholder="Search collections, users..."]');
        if (el instanceof HTMLInputElement) {
          el.focus();
        }
      }, 100);
    }
    
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        isOpen = true;
      }
    });
    return () => { window.removeEventListener('keydown', handleKeydown); };
  });
</script>

{#if isOpen}
  <dialog class="modal modal-open">
    <div class="modal-box max-w-2xl p-0">
      <div class="p-4 border-b border-base-300 dark:border-base-700">
        <div class="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-base-content/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input 
            type="text" 
            bind:value={query}
            class="input input-ghost w-full bg-transparent focus:outline-none border-none placeholder-base-content/40" 
            placeholder="Search collections, users..." 
          />
          <span class="badge badge-sm badge-ghost text-xs">ESC to close</span>
        </div>
        {#if results.length > 0}<div class="text-xs text-base-content/40 mt-2">Showing {results.length} result{results.length !== 1 ? 's' : ''}</div>{/if}
      </div>
      <div class="max-h-96 overflow-y-auto" role="list" aria-label="Search results">
        {#if results.length === 0 && query.length > 0}
          <div class="p-8 text-center text-base-content/40"><p>No results found for "{query}"</p></div>
        {:else if results.length > 0}
          <div class="divide-y divide-base-300 dark:divide-base-700">
            {#each results as result, idx (result.id + result.type)}
              <div 
                class="flex items-center gap-3 px-4 py-3 hover:bg-base-200 dark:hover:bg-base-800 cursor-pointer transition-colors
                       {idx === selectedIdx ? 'bg-primary/10' : ''}" 
                role="option"
                aria-selected="{idx === selectedIdx}"
                tabindex={idx === selectedIdx ? 0 : -1}
                onclick="{handleItemClick}"
                onkeydown="{handleKeydown}"
              >
                {#if result.type === 'collection'}
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                {:else}
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                {/if}
                <div class="flex-1 min-w-0">
                  <p class="font-medium text-base-content">{result.name}</p>
                  <p class="text-xs text-base-content/50 uppercase tracking-wide">{result.type}</p>
                </div>
                <span class="text-xs text-base-content/30">{result.score > 0.8 ? 'Perfect' : result.score > 0.6 ? 'Good' : 'Match'}</span>
              </div>
            {/each}
          </div>
        {:else if query.length === 0}
          <div class="p-8 text-center"><div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-base-200 dark:bg-base-800 mb-3"><svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 text-base-content/40" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div><p class="text-base-content/60">Search for anything...</p><p class="text-xs text-base-content/40 mt-2">Collections, users, and more</p></div>
        {/if}
      </div>
    </div>
  </dialog>
{/if}