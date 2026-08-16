<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  /**
   * The editing surface: device width, the page's twelve-column grid, and the
   * empty state. Everything about blocks themselves now lives in `BlockList`,
   * which renders one level and recurses into containers.
   *
   * The split happened when blocks stopped being a flat array. This file used to
   * hold the drop logic too, keyed on array indices — a model that cannot express
   * "inside the second container, first position", and that silently corrupts
   * itself the moment a move shifts the indices it was holding.
   */
  import type { Block } from '../../lib/builder-types.js';
  import type { Breakpoint } from '../../lib/breakpoints.js';
  import BlockList from './BlockList.svelte';

  let { blocks, selectedId, device, onChange, onSelect }: {
    blocks: Block[];
    selectedId: string | null;
    device: Breakpoint;
    onChange: (b: Block[]) => void;
    onSelect: (id: string | null) => void;
  } = $props();

  /**
   * Shared drag state, passed down by reference so every nesting level agrees
   * about which single drop position is highlighted. Two levels each holding
   * their own would light up two.
   */
  const dragState = $state<{
    active: boolean;
    zone: { parentId: string | null; index: number } | null;
  }>({ active: false, zone: null });

  const widthClass = $derived(
    device === 'base' ? 'max-w-sm' : device === 'tablet' ? 'max-w-2xl' : 'max-w-5xl',
  );
</script>

<div
  class="flex-1 overflow-y-auto bg-base-200 py-8 px-10"
  ondragover={(e) => { e.preventDefault(); dragState.active = true; }}
  ondragleave={() => (dragState.zone = null)}
  ondragend={() => { dragState.active = false; dragState.zone = null; }}
  onclick={() => onSelect(null)}
  role="region"
  aria-label={m['content.pages.b.canvas']()}
>
  <div class="mx-auto transition-all duration-300 grid grid-cols-12 gap-x-4 items-start {widthClass}">
    <BlockList
      {blocks}
      parentId={null}
      tree={blocks}
      {selectedId}
      {dragState}
      {device}
      {onChange}
      {onSelect}
    />

    {#if blocks.length === 0 && !dragState.active}
      <div class="col-span-12 mt-2 border-2 border-dashed border-base-300 rounded-2xl py-24
        flex flex-col items-center gap-3 text-base-content/25 select-none">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <rect x="3" y="3" width="18" height="18" rx="3"/>
          <path d="M12 8v8M8 12h8"/>
        </svg>
        <p class="text-sm">{m['content.pages.b.emptyCanvas']()}</p>
      </div>
    {/if}
  </div>
</div>
