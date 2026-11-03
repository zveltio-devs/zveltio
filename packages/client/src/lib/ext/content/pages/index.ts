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
 * A host loads a page with `loadPage` (`load.ts`) and the menus with
 * `loadMenus`: both read the data API as the visitor. `collection_list` blocks
 * ask the data API for their own rows the same way (`query.ts`), so what a
 * visitor sees is what the engine's rules give them.
 *
 * The section components below are the ORIGINAL public API, kept so existing
 * imports keep working. They cover four block types out of sixteen and know
 * nothing about layout — new code should use `BlockRenderer`.
 *
 * A page's payload also carries `popups: [...]` — pages with `kind = 'popup'`
 * that belong on it, already resolved. Draw each with `<Popup {popup} />`; it
 * handles its own trigger, frequency and dismissal.
 *
 * Requires: the `content/pages` extension active on your Zveltio instance.
 */
export { default as BlockRenderer } from './BlockRenderer.svelte';
export { default as CollectionList } from './CollectionList.svelte';
export { default as Popup } from './Popup.svelte';
export { ICONS, ICON_NAMES, type IconName } from './icons.js';
export { motionAttrs, MOTION_TYPES, type MotionType } from './motion.js';
export { loadPage, loadMenus, loadSite, type PagePayload, type PageInfo, type Site, type MenuItem, type NavItem } from './load.js';
export { listUrl, filterJson, useDataFetch } from './query.js';
export { BLOCK_TYPES, LEGACY_BLOCK_TYPES, ALL_BLOCK_TYPES, type BlockType } from './block-types.js';

// Superseded by BlockRenderer — kept for compatibility.
export { default as HeroSection } from './HeroSection.svelte';
export { default as GridSection } from './GridSection.svelte';
export { default as CTASection } from './CTASection.svelte';
export { default as TextSection } from './TextSection.svelte';
