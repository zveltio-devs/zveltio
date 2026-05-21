<script lang="ts">
  import { LIBRARY, type LibraryBlock } from '../../lib/builder-types.js';

  let { onAdd }: { onAdd: (b: any) => void } = $props();

  const cats = [
    { key: 'layout',  label: 'Layout' },
    { key: 'content', label: 'Content' },
    { key: 'media',   label: 'Media' },
    { key: 'zveltio', label: 'Zveltio' },
  ] as const;

  function make(item: LibraryBlock) {
    return { id: crypto.randomUUID(), type: item.type, props: { ...item.defaultProps }, style: {} };
  }

  function onDragStart(e: DragEvent, item: LibraryBlock) {
    e.dataTransfer!.setData('text/block-type', item.type);
    e.dataTransfer!.effectAllowed = 'copy';
  }
</script>

<div class="w-52 shrink-0 bg-base-100 border-r border-base-300 overflow-y-auto flex flex-col">
  <div class="px-3 py-2.5 border-b border-base-300">
    <span class="text-[10px] font-bold text-base-content/40 uppercase tracking-widest">Blocks</span>
  </div>

  {#each cats as cat}
    {@const items = LIBRARY.filter(b => b.category === cat.key)}
    <div class="px-2 pt-3 pb-1">
      <p class="text-[9px] font-bold text-base-content/30 uppercase tracking-widest px-1 mb-1">{cat.label}</p>
      {#each items as item}
        <button
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-base-200 text-left cursor-grab active:cursor-grabbing transition-colors"
          draggable="true"
          ondragstart={(e) => onDragStart(e, item)}
          onclick={() => onAdd(make(item))}
          title={item.description}
        >
          <span class="text-sm w-5 text-center shrink-0 leading-none">{item.emoji}</span>
          <div class="min-w-0">
            <p class="text-xs font-medium leading-tight">{item.label}</p>
            <p class="text-[10px] text-base-content/40 leading-tight truncate">{item.description}</p>
          </div>
        </button>
      {/each}
    </div>
  {/each}
</div>
