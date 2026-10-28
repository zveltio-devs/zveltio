<script lang="ts">
/** Key figures in a row (`@zveltio/ui/blocks`). */
import { colsClass } from './grid.js';

let { items, columns = 4 }: { items: Array<{ value: string; label: string }>; columns?: number } =
  $props();
</script>

<div class={['grid grid-cols-2 gap-4', colsClass(columns, 4)]}>
  {#each items as s, i (i)}
    <div class="border-base-300 rounded-box border px-4 py-5 text-center">
      <p class="text-3xl font-bold">{s.value}</p>
      <p class="mt-1 text-sm opacity-60">{s.label}</p>
    </div>
  {/each}
</div>
