<script lang="ts">
  import type { Component, Snippet } from 'svelte';

  let {
    title = 'No data yet',
    description = 'Get started by creating your first item',
    icon: Icon,
    actionLabel,
    onaction,
    action,
    className,
  }: {
    title?: string;
    description?: string;
    icon?: Component<any>;
    actionLabel?: string;
    onaction?: () => void;
    action?: Snippet;
    className?: string;
  } = $props();
</script>

<div class="text-center py-12 px-4 {className ?? ''}">
  <div class="mx-auto w-16 h-16 rounded-2xl bg-base-200 flex items-center justify-center mb-5 text-base-content/30">
    {#if Icon}
      <Icon size={32} />
    {:else}
      <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 13h6m-3-3v6m5 5H5a2 2 0 01-2-2V9a2 2 0 012-2h4l3 3h4a2 2 0 012 2v1a2 2 0 01-2 2z" />
      </svg>
    {/if}
  </div>

  <h3 class="text-base font-semibold text-base-content mb-1">{title}</h3>
  <p class="text-sm text-base-content/50 max-w-sm mx-auto mb-6">{description}</p>

  {#if action}
    {@render action()}
  {:else if actionLabel && onaction}
    <button class="btn btn-primary btn-sm" onclick={onaction}>{actionLabel}</button>
  {/if}
</div>
