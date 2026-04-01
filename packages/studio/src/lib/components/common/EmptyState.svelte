<script lang="ts">
  import type { Component } from 'svelte';
  interface Props {
    icon: Component;
    title: string;
    description: string;
    actionLabel?: string;
    actionHref?: string;
    onaction?: () => void;
  }
  let { icon: Icon, title, description, actionLabel, actionHref, onaction }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center py-20 text-center gap-4">
  <div class="p-5 rounded-2xl bg-base-200">
    <Icon size={36} class="text-base-content/20" />
  </div>
  <div class="max-w-xs">
    <h3 class="font-medium text-base-content">{title}</h3>
    <p class="text-sm text-base-content/50 mt-1.5 leading-relaxed">{description}</p>
  </div>
  {#if actionLabel}
    {#if actionHref}
      <a href={actionHref} class="btn btn-primary btn-sm gap-1.5">
        {actionLabel}
      </a>
    {:else if onaction}
      <button class="btn btn-primary btn-sm gap-1.5" onclick={onaction}>
        {actionLabel}
      </button>
    {/if}
  {/if}
</div>
