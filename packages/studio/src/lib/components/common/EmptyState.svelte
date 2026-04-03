<script lang="ts">
  let {
    title = 'No data yet',
    description = 'Get started by creating your first item',
    action,
    className
  }: {
    title?: string;
    description?: string;
    action?: any;
    className?: string;
  } = $props();
</script>

<div class="text-center py-12 px-4 {className ?? ''}">
  <div class="mx-auto w-24 h-24 rounded-2xl bg-base-200 dark:bg-base-800 flex items-center justify-center mb-6 text-base-content/40">
    <svg xmlns="http://www.w3.org/2000/svg" class="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 13h6m-3-3v6m5 5H5a2 2 0 01-2-2V9a2 2 0 012-2h4l3 3h4a2 2 0 012 2v1a2 2 0 01-2 2z" />
    </svg>
  </div>
  
  <h3 class="text-lg font-semibold text-base-content mb-2">{title}</h3>
  <p class="text-base-content/60 max-w-md mx-auto mb-8">{description}</p>
  
  {#if action}
    <div class="flex justify-center">
      {@render action()}
    </div>
  {/if}
  
  <div class="mt-8 text-sm text-base-content/40 text-center">
    <p>Tip: You can also import data from CSV or use our API</p>
  </div>
</div>