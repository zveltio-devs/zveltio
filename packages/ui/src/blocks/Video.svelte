<script lang="ts">
/** An embedded video player (`@zveltio/ui/blocks`); only an http(s) source is framed. */
import { safeFrameSrc } from './href.js';

let { url, title, caption = '' }: { url: string; title: string; caption?: string } = $props();
const src = $derived(safeFrameSrc(url));
</script>

{#if src}
  <figure>
    <div class="aspect-video">
      <iframe {src} {title} class="rounded-box h-full w-full" allowfullscreen></iframe>
    </div>
    {#if caption}<figcaption class="mt-1 text-sm opacity-60">{caption}</figcaption>{/if}
  </figure>
{/if}
