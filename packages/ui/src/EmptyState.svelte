<script lang="ts">
/** What a screen shows when it has nothing yet (`@zveltio/ui`). */
import type { Snippet } from 'svelte';

let {
  title,
  description = '',
  action,
}: { title: string; description?: string; action?: Snippet } = $props();
</script>

<div class="flex flex-col items-center text-center gap-2 py-12 text-base-content/70">
  <p class="text-lg font-semibold text-base-content">{title}</p>
  {#if description}<p class="text-sm max-w-md">{description}</p>{/if}
  {#if action}<div class="mt-2">{@render action()}</div>{/if}
</div>
