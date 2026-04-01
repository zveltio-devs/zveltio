<script lang="ts">
  interface Props { title?: string; padding?: boolean }
  let { title, padding = true } = $props<Props>();
</script>

<div class="border border-base-200 rounded-xl bg-base-100 overflow-hidden">
  {#if title}
    <div class="px-4 py-3 border-b border-base-200 flex items-center justify-between">
      <h2 class="text-sm font-medium text-base-content">{title}</h2>
      <slot name="action" />
    </div>
  {/if}
  <div class="{padding ? 'p-4' : ''}">
    <slot />
  </div>
</div>
