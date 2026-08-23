/**
 * content/pdf-viewer — Client Components
 *
 * Import in your SvelteKit app:
 *   import { PdfViewer, PdfBlock } from 'zveltio-extensions/content/pdf-viewer/client';
 *
 * PdfViewer  — standalone viewer (pass a src URL)
 * PdfBlock   — page-builder block (src can be string or { url, filename })
 *
 * Requires: content/pdf-viewer extension active on your Zveltio instance.
 */
export { default as PdfViewer } from './PdfViewer.svelte';
export { default as PdfBlock } from './PdfBlock.svelte';
