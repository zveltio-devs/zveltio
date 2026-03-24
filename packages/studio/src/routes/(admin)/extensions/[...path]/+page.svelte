<script lang="ts">
 import { page } from '$app/state';
 import { extensionRegistry } from '$lib/extension-registry.svelte.js';
 import { extensions } from '$lib/extensions.svelte.js';

 const pathParts = $derived(page.params.path?.split('/') || []);
 const extName = $derived(pathParts[0]);
 const subPath = $derived('/' + pathParts.slice(1).join('/'));
 const Component = $derived(
 extName ? extensionRegistry.resolveComponent(extName, subPath) : null,
 );
</script>

{#if !extensions.initialized}
 <div class="flex items-center justify-center h-64">
 <span class="loading loading-spinner loading-lg"></span>
 </div>
{:else if Component}
 <Component />
{:else}
 <div class="flex items-center justify-center h-64">
 <div class="text-center opacity-50">
 <p class="text-lg font-semibold">Extension not found</p>
 <p class="text-sm mt-2">
 The extension <code class="font-mono">{extName}</code> is not installed or active.
 </p>
 </div>
 </div>
{/if}
