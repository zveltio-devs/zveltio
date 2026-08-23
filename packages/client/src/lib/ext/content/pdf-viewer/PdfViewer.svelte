<script lang="ts">
  import { onMount } from 'svelte';

  let {
    src,
    height = 600,
    toolbar = true,
  }: {
    src: string;
    height?: number;
    toolbar?: boolean;
  } = $props();

  let PDFViewer: any = $state(null);
  let mounted = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      // EmbedPDF uses WebAssembly — must be imported client-side only.
      const mod = await import('@embedpdf/svelte-pdf-viewer');
      PDFViewer = mod.PDFViewer ?? mod.default;
    } catch (e) {
      console.error('[pdf-viewer] Failed to load EmbedPDF:', e);
      error = 'Could not load PDF viewer.';
    } finally {
      mounted = true;
    }
  });
</script>

{#if error}
  <div class="flex items-center justify-center bg-base-200 rounded" style="height:{height}px">
    <p class="text-sm text-error">{error}</p>
  </div>
{:else if !mounted}
  <div class="flex items-center justify-center bg-base-200 rounded" style="height:{height}px">
    <span class="loading loading-spinner loading-md text-primary"></span>
  </div>
{:else if PDFViewer}
  <svelte:component this={PDFViewer} config={{ src, toolbar }} style="height:{height}px;width:100%;" />
{:else}
  <iframe {src} title="PDF Document" class="w-full rounded border border-base-300" style="height:{height}px"></iframe>
{/if}
