<script lang="ts">
  import { Eye, EyeOff, GripVertical } from '@lucide/svelte';

  interface Column {
    field: string;
    label: string;
    visible?: boolean;
    sortable?: boolean;
    width?: number;
  }

  interface Props {
    fields?: any[];
    columns?: Column[];
    onChange?: (columns: Column[]) => void;
  }

  let { fields = [], columns = [], onChange }: Props = $props();

  // Build column list: merge config columns with all non-system fields
  const allColumns: Column[] = $derived.by(() => {
    const configured = new Map(columns.map(c => [c.field, c]));
    return fields
      .filter((f: any) => !f.is_system)
      .map((f: any) => configured.get(f.name) ?? {
        field: f.name,
        label: f.display_name ?? f.name,
        visible: true,
        sortable: true,
      });
  });

  let dragging: number | null = $state(null);

  function toggleVisible(i: number) {
    const next = allColumns.map((c, idx) =>
      idx === i ? { ...c, visible: !(c.visible ?? true) } : c
    );
    onChange?.(next);
  }

  function updateLabel(i: number, label: string) {
    const next = allColumns.map((c, idx) => idx === i ? { ...c, label } : c);
    onChange?.(next);
  }

  function updateWidth(i: number, width: number) {
    const next = allColumns.map((c, idx) => idx === i ? { ...c, width } : c);
    onChange?.(next);
  }

  // Simple drag-and-drop reorder
  function onDragStart(i: number) { dragging = i; }
  function onDrop(i: number) {
    if (dragging === null || dragging === i) return;
    const next = [...allColumns];
    const [item] = next.splice(dragging, 1);
    next.splice(i, 0, item);
    dragging = null;
    onChange?.(next);
  }
</script>

<div class="flex flex-col gap-1">
  <p class="text-xs text-base-content/50 mb-1">Drag to reorder · click eye to hide</p>
  {#each allColumns as col, i}
    <div
      class="flex items-center gap-2 rounded-lg px-2 py-1.5 bg-base-200 hover:bg-base-300 transition-colors cursor-grab"
      class:opacity-50={dragging === i}
      draggable={true}
      ondragstart={() => onDragStart(i)}
      ondragover={(e) => e.preventDefault()}
      ondrop={() => onDrop(i)}
    >
      <GripVertical size={14} class="text-base-content/30 shrink-0"/>

      <!-- Visible toggle -->
      <button class="btn btn-ghost btn-xs" onclick={() => toggleVisible(i)}
        title={col.visible !== false ? 'Hide column' : 'Show column'}>
        {#if col.visible !== false}
          <Eye size={14} class="text-primary"/>
        {:else}
          <EyeOff size={14} class="text-base-content/30"/>
        {/if}
      </button>

      <!-- Label -->
      <input
        class="input input-xs input-bordered flex-1 min-w-0"
        type="text"
        value={col.label}
        oninput={(e) => updateLabel(i, (e.target as HTMLInputElement).value)}
      />

      <!-- Width -->
      <input
        class="input input-xs input-bordered w-16 text-center"
        type="number"
        min={40}
        max={600}
        value={col.width ?? ''}
        placeholder="auto"
        oninput={(e) => {
          const v = parseInt((e.target as HTMLInputElement).value);
          if (!isNaN(v)) updateWidth(i, v);
        }}
      />
    </div>
  {/each}
</div>