<script lang="ts">
  import PdfViewer from './PdfViewer.svelte';

  let {
    src,
    height = 600,
    toolbar = true,
    title,
  }: {
    src: string | { url: string; filename?: string };
    height?: number;
    toolbar?: boolean;
    title?: string;
  } = $props();

  const resolvedSrc = $derived(typeof src === 'string' ? src : (src as any)?.url ?? '');
</script>

<section class="zveltio-block zveltio-block--pdf">
  {#if title}
    <h2 class="text-lg font-semibold mb-3">{title}</h2>
  {/if}

  {#if resolvedSrc}
    <PdfViewer src={resolvedSrc} {height} {toolbar} />
  {:else}
    <div class="flex items-center justify-center bg-base-200 rounded text-base-content/40 text-sm" style="height:{height}px">
      No PDF document selected.
    </div>
  {/if}
</section>
