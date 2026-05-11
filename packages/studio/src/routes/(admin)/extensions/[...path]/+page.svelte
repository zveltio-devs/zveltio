<script lang="ts">
  import { page } from '$app/state';
  import { extensions } from '$lib/extensions.svelte.js';
  import { Puzzle, CheckCircle } from '@lucide/svelte';

  const paramPath = $derived(page.params.path ?? '');

  // Longest-prefix match against extension names (e.g. "compliance/ro/efactura")
  const extMeta = $derived(
    extensions.meta
      .slice()
      .sort((a, b) => b.name.length - a.name.length)
      .find((m) => paramPath === m.name || paramPath.startsWith(m.name + '/')) ?? null,
  );

  const isActive = $derived(extMeta ? extensions.isActive(extMeta.name) : false);
</script>

{#if !extensions.initialized}
  <div class="flex items-center justify-center h-64">
    <span class="loading loading-spinner loading-lg"></span>
  </div>
{:else if isActive && extMeta}
  <!-- Extension active but no dedicated Studio page compiled in yet -->
  <div class="max-w-lg mx-auto mt-16 text-center space-y-4">
    <div class="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
      <Puzzle size={28} class="text-primary" />
    </div>
    <div>
      <h1 class="text-xl font-semibold">{extMeta.displayName ?? extMeta.name}</h1>
      {#if extMeta.description}
        <p class="text-sm text-base-content/60 mt-1">{extMeta.description}</p>
      {/if}
    </div>
    <div class="flex items-center justify-center gap-2 text-sm text-success font-medium">
      <CheckCircle size={16} />
      <span>Extension active</span>
    </div>
    {#if extMeta.contributes?.engine}
      <p class="text-sm text-base-content/50">
        This extension adds API capabilities. Configure it via Settings or use its API endpoints directly.
      </p>
    {/if}
  </div>
{:else}
  <div class="flex items-center justify-center h-64">
    <div class="text-center opacity-50">
      <p class="text-lg font-semibold">Extension not found</p>
      <p class="text-sm mt-2">
        The extension <code class="font-mono">{paramPath}</code> is not installed or active.
      </p>
    </div>
  </div>
{/if}
