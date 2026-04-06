<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title?: string;
    padding?: boolean;
    children: Snippet;
    action?: Snippet;
  }
  let { title, padding = true, children, action }: Props = $props();
</script>

<div class="border border-base-200 rounded-xl bg-base-100 overflow-hidden">
  {#if title}
    <div class="px-4 py-3 border-b border-base-200 flex items-center justify-between">
      <h2 class="text-sm font-medium text-base-content">{title}</h2>
      {#if action}{@render action()}{/if}
    </div>
  {/if}
  <div class="{padding ? 'p-4' : ''}">
    {@render children()}
  </div>
</div>
