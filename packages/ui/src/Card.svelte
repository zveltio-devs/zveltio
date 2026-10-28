<script lang="ts">
/** A card (`@zveltio/ui`): optional title, body, optional actions row. */
import type { Snippet } from 'svelte';

let {
  title = '',
  children,
  actions,
}: { title?: string; children: Snippet; actions?: Snippet } = $props();
</script>

<section class="card bg-base-100 shadow">
  <div class="card-body gap-3">
    {#if title}<h2 class="card-title">{title}</h2>{/if}
    {@render children()}
    {#if actions}<div class="card-actions justify-end items-center">{@render actions()}</div>{/if}
  </div>
</section>
