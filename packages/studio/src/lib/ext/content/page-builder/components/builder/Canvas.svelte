<script lang="ts">
import type { Block, DeviceMode } from '../../lib/builder-types.js';
import { LIBRARY } from '../../lib/builder-types.js';
import BlockPreview from './BlockPreview.svelte';
import { GripVertical, ChevronUp, ChevronDown, X } from '@lucide/svelte';

let {
  blocks,
  selectedId,
  device,
  onChange,
  onSelect,
}: {
  blocks: Block[];
  selectedId: string | null;
  device: DeviceMode;
  onChange: (b: Block[]) => void;
  onSelect: (id: string) => void;
} = $props();

// Index of the drop zone that is currently highlighted (= "insert before block[i]")
let dropZone = $state<number | null>(null);

const widthClass = $derived(
  device === 'mobile' ? 'max-w-sm' : device === 'tablet' ? 'max-w-2xl' : 'max-w-5xl',
);

// ── Drag handlers ────────────────────────────────────────────────────────────

function onHandleDragStart(e: DragEvent, i: number) {
  e.dataTransfer!.setData('text/canvas-index', String(i));
  e.dataTransfer!.effectAllowed = 'move';
  e.stopPropagation();
}

function onZoneDragOver(e: DragEvent, i: number) {
  e.preventDefault();
  e.stopPropagation();
  dropZone = i;
}

function onDrop(e: DragEvent, insertAt: number) {
  e.preventDefault();
  e.stopPropagation();
  const prevZone = dropZone;
  dropZone = null;

  const fromType = e.dataTransfer!.getData('text/block-type');
  const fromIndex = e.dataTransfer!.getData('text/canvas-index');

  if (fromType) {
    // Dropped from library → insert new block
    const lib = LIBRARY.find((b) => b.type === fromType);
    if (!lib) return;
    const nb: Block = {
      id: crypto.randomUUID(),
      type: lib.type,
      props: { ...lib.defaultProps },
      style: {},
    };
    const arr = [...blocks];
    arr.splice(insertAt, 0, nb);
    onChange(arr);
    onSelect(nb.id);
  } else if (fromIndex !== '') {
    // Reordering within canvas
    const fi = Number(fromIndex);
    if (fi === insertAt || fi + 1 === insertAt) return;
    const arr = [...blocks];
    const [moved] = arr.splice(fi, 1);
    const target = fi < insertAt ? insertAt - 1 : insertAt;
    arr.splice(target, 0, moved);
    onChange(arr);
  }

  void prevZone;
}

function onDragLeaveCanvas() {
  dropZone = null;
}

// ── Block controls ────────────────────────────────────────────────────────────

function move(i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= blocks.length) return;
  const arr = [...blocks];
  [arr[i], arr[j]] = [arr[j], arr[i]];
  onChange(arr);
}

function remove(i: number) {
  onChange(blocks.filter((_, idx) => idx !== i));
}
</script>

<div
  class="flex-1 overflow-y-auto bg-base-200 py-8 px-8"
  ondragleave={onDragLeaveCanvas}
  role="region"
  aria-label="Page canvas"
>
  <div class="mx-auto transition-all duration-300 {widthClass}">

    {#each blocks as block, i}

      <!-- Drop zone before block[i] -->
      <div
        class="rounded-full mx-2 transition-all duration-150
          {dropZone === i ? 'h-8 bg-primary/15 border-2 border-dashed border-primary my-2' : 'h-1.5 my-1'}"
        ondragover={(e) => onZoneDragOver(e, i)}
        ondrop={(e) => onDrop(e, i)}
        role="region"
        aria-label="Drop zone"
      ></div>

      <!-- Block wrapper -->
      <div
        class="group relative rounded-xl transition-all duration-100 cursor-pointer
          {selectedId === block.id
            ? 'ring-2 ring-primary shadow-lg shadow-primary/10'
            : 'hover:ring-2 hover:ring-base-300'}"
        onclick={() => onSelect(block.id)}
        role="button"
        tabindex="0"
        onkeydown={(e) => e.key === 'Enter' && onSelect(block.id)}
      >
        <!-- Controls bar (top-right, shown on hover/select) -->
        <div class="absolute -top-3.5 right-2 z-20 flex items-center gap-0.5
          bg-base-100 border border-base-300 rounded-lg px-1 py-0.5 shadow-sm
          opacity-0 group-hover:opacity-100 transition-opacity
          {selectedId === block.id ? '!opacity-100' : ''}">
          <span class="text-[9px] font-mono text-base-content/40 px-1 border-r border-base-300 mr-0.5">{block.type}</span>
          <button
            class="btn btn-ghost btn-xs p-0.5 h-5 min-h-0"
            onclick={(e) => { e.stopPropagation(); move(i, -1); }}
            disabled={i === 0}
            title="Move up"
          ><ChevronUp size={11} /></button>
          <button
            class="btn btn-ghost btn-xs p-0.5 h-5 min-h-0"
            onclick={(e) => { e.stopPropagation(); move(i, 1); }}
            disabled={i === blocks.length - 1}
            title="Move down"
          ><ChevronDown size={11} /></button>
          <button
            class="btn btn-ghost btn-xs p-0.5 h-5 min-h-0 text-error"
            onclick={(e) => { e.stopPropagation(); remove(i); }}
            title="Delete block"
          ><X size={11} /></button>
        </div>

        <!-- Drag handle (left side) -->
        <div
          class="absolute -left-6 top-1/2 -translate-y-1/2 z-10
            cursor-grab active:cursor-grabbing
            opacity-0 group-hover:opacity-40 hover:!opacity-80 transition-opacity
            text-base-content"
          draggable="true"
          ondragstart={(e) => onHandleDragStart(e, i)}
          ondragend={() => (dropZone = null)}
          role="button"
          tabindex="-1"
          aria-label="Drag to reorder"
        >
          <GripVertical size={16} />
        </div>

        <BlockPreview {block} />
      </div>

    {/each}

    <!-- Drop zone after last block -->
    <div
      class="rounded-full mx-2 transition-all duration-150
        {dropZone === blocks.length ? 'h-8 bg-primary/15 border-2 border-dashed border-primary my-2' : 'h-1.5 my-1'}"
      ondragover={(e) => onZoneDragOver(e, blocks.length)}
      ondrop={(e) => onDrop(e, blocks.length)}
      role="region"
      aria-label="Drop zone"
    ></div>

    <!-- Empty state -->
    {#if blocks.length === 0}
      <div
        class="mt-2 border-2 border-dashed rounded-2xl py-24 flex flex-col items-center gap-3 transition-colors
          {dropZone === 0
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-base-300 text-base-content/25'}"
        ondragover={(e) => onZoneDragOver(e, 0)}
        ondrop={(e) => onDrop(e, 0)}
        role="region"
      >
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <rect x="3" y="3" width="18" height="18" rx="3"/>
          <path d="M12 8v8M8 12h8"/>
        </svg>
        <p class="text-sm">Drag blocks from the left panel or click to add</p>
      </div>
    {/if}

  </div>
</div>
