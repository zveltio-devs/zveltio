<script lang="ts">
/** An image with an optional link and caption (`@zveltio/ui/blocks`). */
import { safeHref } from './href.js';

let {
  src,
  alt = '',
  href = '',
  width = '',
  caption = '',
}: { src: string; alt?: string; href?: string; width?: string; caption?: string } = $props();
// Only a plain length reaches the style attribute, never extra declarations.
const w = $derived(/^\d{1,4}(\.\d{1,4})?(px|rem|em|%)$/.test(width ?? '') ? width : undefined);
</script>

<figure>
  {#if href}
    <a href={safeHref(href)}><img {src} {alt} class="rounded-box h-auto max-w-full" style:width={w} /></a>
  {:else}
    <img {src} {alt} class="rounded-box h-auto max-w-full" style:width={w} />
  {/if}
  {#if caption}<figcaption class="mt-1 text-sm opacity-60">{caption}</figcaption>{/if}
</figure>
