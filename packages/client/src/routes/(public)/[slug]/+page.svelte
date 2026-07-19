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
    <meta property="og:description" content={data.page.meta_description} />
  {/if}
  <meta property="og:title" content={data.page?.meta_title ?? data.page?.title ?? 'Page'} />
  <meta property="og:type" content="website" />
  {#if data.page?.og_image}
    <meta property="og:image" content={data.page.og_image} />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content={data.page.og_image} />
  {/if}
  {#if typeof window !== 'undefined'}
    <link rel="canonical" href={window.location.origin + window.location.pathname} />
  {/if}
  {#if data.page?.noindex}
    <meta name="robots" content="noindex, nofollow" />
  {/if}
</svelte:head>

<BlockRenderer blocks={data.blocks} />
