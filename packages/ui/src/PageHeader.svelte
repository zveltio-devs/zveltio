<script lang="ts">
/** A page's title and its actions (`@zveltio/ui`). */
import type { Snippet } from 'svelte';

let { title, actions }: { title: string; actions?: Snippet } = $props();
</script>

<div class="flex flex-wrap items-center gap-3">
  <h1 class="text-2xl font-bold flex-1">{title}</h1>
  {#if actions}{@render actions()}{/if}
</div>
