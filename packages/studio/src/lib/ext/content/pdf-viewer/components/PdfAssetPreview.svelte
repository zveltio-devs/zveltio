<script lang="ts">
  let { asset }: { asset: { url: string; name?: string; mimeType?: string } } = $props();
</script>

<!-- Studio preview uses browser native PDF viewer via iframe.
     EmbedPDF (WASM) is not used here because Studio bundles are IIFE —
     full EmbedPDF is available in the client/ package for SvelteKit apps. -->
<iframe
  src={asset.url}
  title={asset.name ?? 'PDF Document'}
  class="w-full rounded border border-base-300"
  style="height: 65vh; min-height: 400px;"
></iframe>
