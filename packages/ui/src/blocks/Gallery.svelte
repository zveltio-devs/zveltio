<script lang="ts">
/** A grid of images (`@zveltio/ui/blocks`). */
import { colsClass } from './grid.js';

let { images, columns = 3 }: { images: Array<{ url: string; alt?: string }>; columns?: number } =
  $props();
</script>

<div class={['grid grid-cols-2 gap-3', colsClass(columns, 3)]}>
  {#each images as img, i (i)}
    {#if img.url}<img src={img.url} alt={img.alt ?? ''} class="rounded-box h-auto w-full" />{/if}
  {/each}
</div>
