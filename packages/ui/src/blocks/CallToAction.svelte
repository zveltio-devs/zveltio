<script lang="ts">
/** A call to action (`@zveltio/ui/blocks`): heading, text, one button. */
import { type LinkVariant } from './href.js';
import LinkButton from './LinkButton.svelte';

let {
  heading = '',
  text = '',
  action = null,
}: {
  heading?: string;
  text?: string;
  action?: { label: string; href: string; variant?: LinkVariant } | null;
} = $props();
</script>

<section class="bg-base-200 rounded-box px-6 py-10 text-center">
  {#if heading}<h2 class="text-2xl font-bold">{heading}</h2>{/if}
  {#if text}<p class="mt-2 opacity-70">{text}</p>{/if}
  {#if action?.label}<LinkButton {...action} class="mt-5" />{/if}
</section>
