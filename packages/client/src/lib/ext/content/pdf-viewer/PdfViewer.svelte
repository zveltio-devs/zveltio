<script lang="ts">
  import { onMount, type Component } from 'svelte';

  let {
    src,
    height = 600,
    toolbar = true,
  }: {
    src: string;
    /** Viewer height in px. */
    height?: number;
    /**
     * Show the reader's own controls.
     *
     * Honoured by the browser fallback through the standard `#toolbar=0` PDF
     * fragment, which Chromium and Edge implement. The enhanced viewer ignores
     * it: its toolbar IS the product, and EmbedPDF exposes no switch for the bar
     * as a whole — only `disabledCategories` for individual features.
     *
     * Documented rather than faked. It used to be passed straight into a config
     * key that does not exist on `PDFViewerConfig`, so it did nothing at all, in
     * either renderer.
     */
    toolbar?: boolean;
  } = $props();

  /**
   * The optional viewer, once loaded.
   *
   * Typed as a Svelte `Component` rather than `any`: it is a component
   * constructor resolved at runtime, and that is a thing the type system can
   * name. `any-ratchet` asked for this and was right to.
   */
  type ViewerProps = { config: unknown; style?: string };
  let PDFViewer: Component<ViewerProps> | null = $state(null);
  let mounted = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      // EmbedPDF uses WebAssembly, so it can only be imported in the browser —
      // and dynamically, so it lands in its own chunk rather than in the bundle
      // every page pays for. A host that never opens a PDF never downloads it.
      // `@ts-ignore`, not `@ts-expect-error`, and the difference matters here:
      // this module is OPTIONAL. Absent — the state the product ships in — the
      // import does not resolve and needs suppressing; present, in a host that
      // installed it, `@ts-expect-error` would itself become an error for
      // suppressing nothing. `@ts-ignore` is correct in both, which is the point.
      // @ts-ignore - optional peer, see the README
      const mod = await import('@embedpdf/svelte-pdf-viewer');
      // `mod.PDFViewer`, with no `?? mod.default`. That fallback was written
      // against a module nobody could see, because the package was declared
      // nowhere; the moment it became a real dependency `svelte-check` reported
      // that `default` is not on its type. It exports the one named component.
      // Cast at the boundary, through `unknown`, and only here. EmbedPDF ships a
      // Svelte-4-and-5 "isomorphic" component type that does not assign to
      // `Component<…>`; widening the field to `any` to avoid one cast would put
      // the looseness everywhere instead of at the single point where an
      // optional module crosses into typed code.
      PDFViewer = mod.PDFViewer as unknown as Component<ViewerProps>;
    } catch (e) {
      // Leave `PDFViewer` null and fall through to the <iframe> below. Every
      // browser this Studio supports renders a PDF natively, so a viewer that
      // did not load is a downgrade, not a failure — and the fallback is what
      // keeps the feature working in a host that trimmed the dependency.
      //
      // This used to set `error`, and `error` is the FIRST branch, so the
      // fallback three branches down was unreachable. Combined with the package
      // being declared in no package.json in either repository, that catch ran
      // every single time: the feature had only ever shown "Could not load PDF
      // viewer." `error` is kept for a document that genuinely cannot be shown.
      console.warn(
        '[pdf-viewer] @embedpdf/svelte-pdf-viewer did not load; using the browser viewer:',
        e,
      );
    } finally {
      mounted = true;
    }
  });

  /**
   * What the enhanced viewer is given.
   *
   * `fontFallback: null` is the load-bearing line. Left at its default the
   * viewer fetches substitute fonts from jsDelivr the first time a PDF needs
   * one — an outbound request to a third party, from a product whose buyers run
   * it self-hosted precisely so that does not happen. Off here; a deployment
   * that wants the fallback can serve the fonts itself and pass its own config.
   */
  const viewerConfig = $derived({ src, fontFallback: null });

  /** `#toolbar=0` is the standard PDF fragment; Chromium and Edge honour it. */
  const iframeSrc = $derived(toolbar ? src : `${src}#toolbar=0`);
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
  <!-- In runes mode a capitalised variable IS a dynamic component;
       `<svelte:component>` is deprecated and does the same thing. -->
  <PDFViewer config={viewerConfig} style="height:{height}px;width:100%;" />
{:else}
  <iframe
    src={iframeSrc}
    title="PDF Document"
    class="w-full rounded border border-base-300"
    style="height:{height}px"
  ></iframe>
{/if}
