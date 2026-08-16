/**
 * content/pages — client components for rendering a page's blocks.
 *
 * The whole job in one component:
 *
 *   import { BlockRenderer } from 'zveltio-extensions/content/pages/client';
 *   <BlockRenderer blocks={page.blocks} />
 *
 * `BlockRenderer` draws every block type the visual builder can author, plus the
 * four names the older textarea editor wrote, and honours `col_span` on a
 * twelve-column grid.
 *
 * `collection_list` blocks arrive with their rows already resolved by the server
 * in `content._data` — or `content._error` when the caller may not read them,
 * which on a public site means the collection is not in that site's
 * `public_collections`. `CollectionList` never queries: the server already
 * decided what this caller may see, and a second authorisation path is the shape
 * that produced the leak this area was repaired for.
 *
 * The section components below are the ORIGINAL public API, kept so existing
 * imports keep working. They cover four block types out of sixteen and know
 * nothing about layout — new code should use `BlockRenderer`.
 *
 * Requires: the `content/pages` extension active on your Zveltio instance.
 */
export { default as BlockRenderer } from './BlockRenderer.svelte';
export { default as CollectionList } from './CollectionList.svelte';
export { BLOCK_TYPES, LEGACY_BLOCK_TYPES, ALL_BLOCK_TYPES, type BlockType } from './block-types.js';

// Superseded by BlockRenderer — kept for compatibility.
export { default as HeroSection } from './HeroSection.svelte';
export { default as GridSection } from './GridSection.svelte';
export { default as CTASection } from './CTASection.svelte';
export { default as TextSection } from './TextSection.svelte';
