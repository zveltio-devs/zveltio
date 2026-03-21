<script lang="ts">
  import { error } from '@sveltejs/kit';
  import HeroSection from '$lib/components/sections/HeroSection.svelte';
  import GridSection from '$lib/components/sections/GridSection.svelte';
  import CTASection from '$lib/components/sections/CTASection.svelte';
  import TextSection from '$lib/components/sections/TextSection.svelte';

  const componentMap: Record<string, any> = {
    hero: HeroSection,
    grid: GridSection,
    cta: CTASection,
    text: TextSection,
  };

  let { data } = $props();

  if (!data.page) {
    error(404, 'Page not found');
  }
</script>

<svelte:head>
  <title>{data.page.title}</title>
  {#if data.page.meta_description}
    <meta name="description" content={data.page.meta_description} />
  {/if}
</svelte:head>

{#if data.page?.sections}
  {#each data.page.sections as section}
    {#if componentMap[section.type]}
      <svelte:component this={componentMap[section.type]} {...section.props} />
    {/if}
  {/each}
{/if}
