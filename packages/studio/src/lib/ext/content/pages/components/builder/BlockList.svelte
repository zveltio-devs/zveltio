<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  /**
   * One level of the block tree, and — for a container — the levels beneath it.
   *
   * This was the body of `Canvas.svelte`, written when a page was a flat array:
   * every operation was an index, and the drop zone before block `i` was just
   * `i`. With containers an index means nothing on its own, so a position is now
   * a PAIR — the container it belongs to (or null for the page itself) and the
   * index inside it — and every mutation goes through `block-tree.ts`, which
   * works by id.
   *
   * The component renders itself for a container's children. Recursion is safe
   * because only `container` recurses and `moveTo` refuses to place a container
   * inside its own subtree, which is the move that would otherwise build a cycle
   * and hang the editor.
   */
  import type { Block } from '../../lib/builder-types.js';
  import { LIBRARY } from '../../lib/builder-types.js';
  import { childrenOf, insertAt, isContainer, moveTo, nudge, removeById } from '../../lib/block-tree.js';
  import { spanKey, type Breakpoint } from '../../lib/breakpoints.js';
  import BlockPreview from './BlockPreview.svelte';
  import Self from './BlockList.svelte';
  import { GripVertical, ChevronUp, ChevronDown, X } from '@lucide/svelte';

  let {
    /** The blocks at THIS level. */
    blocks,
    /** The container holding them, or null at the page's top level. */
    parentId = null,
    /** The whole page — every mutation is computed against the full tree. */
    tree,
    selectedId,
    dragState,
    device = 'tablet',
    onChange,
    onSelect,
  }: {
    blocks: Block[];
    parentId?: string | null;
    tree: Block[];
    selectedId: string | null;
    dragState: { active: boolean; zone: { parentId: string | null; index: number } | null };
    /** Which size the canvas is previewing — blocks are drawn at that width. */
    device?: Breakpoint;
    onChange: (t: Block[]) => void;
    onSelect: (id: string) => void;
  } = $props();

  const GAP: Record<string, string> = { none: 'gap-0', sm: 'gap-2', md: 'gap-4', lg: 'gap-8' };

  /** Tailwind needs whole class names; `col-span-${n}` is never generated. */
  const SPAN: Record<number, string> = {
    1: 'col-span-1', 2: 'col-span-2', 3: 'col-span-3', 4: 'col-span-4',
    5: 'col-span-5', 6: 'col-span-6', 7: 'col-span-7', 8: 'col-span-8',
    9: 'col-span-9', 10: 'col-span-10', 11: 'col-span-11', 12: 'col-span-12',
  };

  /**
   * The width to DRAW at, for the size being previewed.
   *
   * Falls back the way the published page falls back — desktop to tablet, tablet
   * to the phone default — so switching device in the editor shows what a
   * visitor on that device would actually see, including inherited widths.
   */
  function spanClass(block: Block): string {
    const at = (bp: Breakpoint) => Number((block as any)[spanKey(bp)]);
    const chain =
      device === 'desktop' ? [at('desktop'), at('tablet')] :
      device === 'tablet'  ? [at('tablet')] :
      [at('base'), 12];
    const n = chain.find((v) => SPAN[v]) ?? 12;
    return SPAN[n];
  }

  function isZone(index: number): boolean {
    return dragState.zone?.parentId === parentId && dragState.zone?.index === index;
  }

  function onZoneDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    dragState.active = true;
    dragState.zone = { parentId, index };
  }

  function onHandleDragStart(e: DragEvent, id: string) {
    e.dataTransfer!.setData('text/block-id', id);
    e.dataTransfer!.effectAllowed = 'move';
    dragState.active = true;
    e.stopPropagation();
  }

  function onDrop(e: DragEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    dragState.zone = null;
    dragState.active = false;

    const fromType = e.dataTransfer!.getData('text/block-type');
    const fromId = e.dataTransfer!.getData('text/block-id');

    if (fromType) {
      const lib = LIBRARY.find((b) => b.type === fromType);
      if (!lib) return;
      const nb: Block = {
        id: crypto.randomUUID(),
        type: lib.type,
        content: structuredClone(lib.defaultContent),
        style: {},
        col_span: 12,
      };
      onChange(insertAt(tree, parentId, index, nb));
      onSelect(nb.id);
    } else if (fromId) {
      // `moveTo` removes first and then inserts, so the index means the same
      // thing whether the block came from above, below, or another container.
      onChange(moveTo(tree, fromId, parentId, index));
    }
  }
</script>

{#snippet dropZone(index: number)}
  {#if dragState.active}
    <div
      class="col-span-12 rounded-full transition-all duration-150
        {isZone(index) ? 'h-8 bg-primary/15 border-2 border-dashed border-primary my-1' : 'h-1.5'}"
      ondragover={(e) => onZoneDragOver(e, index)}
      ondrop={(e) => onDrop(e, index)}
      role="region"
      aria-label={m['content.pages.b.dropPosition']()}
    ></div>
  {/if}
{/snippet}

{#each blocks as block, i (block.id)}
  {@render dropZone(i)}

  <div
    class="group/blk relative rounded-xl transition-all duration-100 cursor-pointer
      {spanClass(block)}
      {selectedId === block.id
        ? 'ring-2 ring-primary shadow-lg shadow-primary/10'
        : 'hover:ring-2 hover:ring-base-300'}"
    onclick={(e) => { e.stopPropagation(); onSelect(block.id); }}
    role="button"
    tabindex="0"
    onkeydown={(e) => e.key === 'Enter' && onSelect(block.id)}
  >
    <!-- Controls, on hover or when selected -->
    <div class="absolute -top-3.5 right-2 z-20 flex items-center gap-0.5
      bg-base-100 border border-base-300 rounded-lg px-1 py-0.5 shadow-sm
      opacity-0 group-hover/blk:opacity-100 transition-opacity
      {selectedId === block.id ? '!opacity-100' : ''}">
      <span class="text-[9px] font-mono text-base-content/40 px-1 border-r border-base-300 mr-0.5">{block.type}</span>
      <button class="btn btn-ghost btn-xs p-0.5 h-5 min-h-0" title={m['content.pages.b.moveUp']()}
        onclick={(e) => { e.stopPropagation(); onChange(nudge(tree, block.id, -1)); }}
        disabled={i === 0}><ChevronUp size={11} /></button>
      <button class="btn btn-ghost btn-xs p-0.5 h-5 min-h-0" title={m['content.pages.b.moveDown']()}
        onclick={(e) => { e.stopPropagation(); onChange(nudge(tree, block.id, 1)); }}
        disabled={i === blocks.length - 1}><ChevronDown size={11} /></button>
      <button class="btn btn-ghost btn-xs p-0.5 h-5 min-h-0 text-error" title={m['content.pages.b.deleteBlock']()}
        onclick={(e) => { e.stopPropagation(); onChange(removeById(tree, block.id)); }}
      ><X size={11} /></button>
    </div>

    <div
      class="absolute -left-5 top-1/2 -translate-y-1/2 z-10 cursor-grab active:cursor-grabbing
        opacity-0 group-hover/blk:opacity-40 hover:!opacity-80 transition-opacity text-base-content"
      draggable="true"
      ondragstart={(e) => onHandleDragStart(e, block.id)}
      ondragend={() => { dragState.zone = null; dragState.active = false; }}
      role="button"
      tabindex="-1"
      aria-label={m['content.pages.b.dragReorder']()}
    ><GripVertical size={15} /></div>

    {#if isContainer(block)}
      <!--
        A container is drawn as its contents, not as a preview of them. Its own
        dashed outline is the only chrome, so what the author sees inside is the
        same grid the published page uses.

        A data block in `template` mode nests the same way — `childrenOf` returns
        its item template — so it gets the same editable slot, with a label
        saying what the one block inside actually means.
      -->
      {#if block.type === 'collection_list'}
        <p class="text-[10px] font-mono uppercase tracking-widest text-base-content/40 px-1 pb-1">
          {m['content.pages.b.repeatsFor']()} {block.content?.collection || '—'}
        </p>
      {/if}
      <div class="rounded-xl border border-dashed border-base-300/80 p-3 min-h-[5rem]
        grid grid-cols-12 items-start {GAP[block.content?.gap ?? 'md'] ?? GAP.md}">
        <Self
          blocks={childrenOf(block)}
          parentId={block.id}
          {tree}
          {selectedId}
          {dragState}
          {device}
          {onChange}
          {onSelect}
        />
        {#if childrenOf(block).length === 0 && !dragState.active}
          <p class="col-span-12 text-center text-xs text-base-content/30 py-6 select-none">
            {m['content.pages.b.emptyContainer']()}
          </p>
        {/if}
      </div>
    {:else}
      <BlockPreview {block} />
    {/if}
  </div>
{/each}

{@render dropZone(blocks.length)}
