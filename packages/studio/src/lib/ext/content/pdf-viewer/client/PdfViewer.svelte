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
      // @ts-expect-error - optional peer: @embedpdf/svelte-pdf-viewer is not a
      // dependency of this extension or of either host, by design. It is loaded
      // if an integrator installed it, and the browser's own viewer is used if
      // not — see the catch below. TypeScript cannot resolve a module nobody
      // declares, and declaring it would be a lie about what ships.
      const mod = await import('@embedpdf/svelte-pdf-viewer');
      PDFViewer = mod.PDFViewer ?? mod.default;
    } catch (e) {
      // Leave `PDFViewer` null and fall through to the <iframe> below, which is
      // what the branch at the bottom of this file was written for: every
      // browser this Studio supports renders a PDF natively in an iframe, so a
      // missing enhanced viewer is a downgrade, not a failure.
      //
      // This used to set `error`, and `error` is the FIRST branch — so the
      // fallback three branches down was unreachable, and the one thing that
      // always works was never tried. It matters here rather than in theory:
      // `@embedpdf/svelte-pdf-viewer` is declared in no package.json in either
      // repository and installed in neither, so this catch runs every single
      // time and the feature has only ever shown "Could not load PDF viewer."
      //
      // `error` stays for a document that genuinely cannot be shown; a viewer
      // that could not be loaded is not one.
      console.warn(
        '[pdf-viewer] @embedpdf/svelte-pdf-viewer did not load; using the browser viewer:',
        e,
      );
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
