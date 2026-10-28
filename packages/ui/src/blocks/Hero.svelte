<script lang="ts">
/**
 * A page's opening section (`@zveltio/ui/blocks`). Follows the theme
 * (`bg-base-200`); `background` and `color` override it for one hero.
 */
import { type LinkVariant } from './href.js';
import LinkButton from './LinkButton.svelte';

let {
  title,
  subtitle = '',
  imageUrl = '',
  action = null,
  background = '',
  color = '',
}: {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  action?: { label: string; href: string; variant?: LinkVariant } | null;
  background?: string;
  color?: string;
} = $props();
</script>

<section
  class="bg-base-200 text-base-content rounded-box px-6 py-14 text-center"
  style:background-color={background || undefined}
  style:color={color || undefined}
>
  {#if imageUrl}<img src={imageUrl} alt="" class="rounded-box mx-auto mb-6 max-w-sm" />{/if}
  <h1 class="text-4xl font-bold tracking-tight sm:text-5xl">{title}</h1>
  {#if subtitle}<p class="mt-4 text-lg opacity-80">{subtitle}</p>{/if}
  {#if action?.label}<LinkButton {...action} class="mt-6" />{/if}
</section>
