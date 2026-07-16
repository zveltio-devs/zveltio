<script lang="ts">
import { error } from '@sveltejs/kit';
import { untrack } from 'svelte';
import BlockRenderer from '$lib/blocks/BlockRenderer.svelte';

let { data } = $props();

if (untrack(() => data.status === 404 || !data.page)) {
  error(404, 'Page not found');
}
</script>

<svelte:head>
  <title>{data.page?.meta_title ?? data.page?.title ?? 'Page'}</title>
  {#if data.page?.meta_description}
    <meta name="description" content={data.page.meta_description} />
  {/if}
</svelte:head>

<BlockRenderer blocks={data.blocks} />
