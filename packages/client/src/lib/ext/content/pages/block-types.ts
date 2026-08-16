/**
 * The block vocabulary — one list, in the extension that defines it.
 *
 * There were four of these and none agreed: the builder's library, the textarea
 * editor's, the `zv_page_block_types` seed, and the reference host's renderer.
 * They drifted because each was written where it was needed and nothing ever
 * compared them, so a page authored with the builder rendered as ten
 * "Unsupported block" placeholders on the public site for three months.
 *
 * This file is the reference the others are checked against — see
 * `block-contract.test.ts`, which fails if the builder can add a block the
 * renderer cannot draw. Adding a block type means adding it here first.
 */

/** Types the visual builder offers and the renderer draws. */
export const BLOCK_TYPES = [
  'container',
  'hero',
  'richtext',
  'image',
  'cta',
  'stats',
  'embed',
  'spacer',
  'video',
  'gallery',
  'divider',
  'collection_list',
] as const;

/**
 * Types still present in stored pages that the builder no longer offers. The
 * renderer draws them; nothing rewrites them, because reading an old name is
 * cheaper and safer than a data migration over every page on every install.
 *
 * `heading`, `text`, `button` and `html` came from the textarea editor.
 * `columns` is newer and retires for a different reason: it stored its columns
 * as raw HTML STRINGS, so nothing could be placed inside one — not an image,
 * not a data block. `container` replaces it by holding real blocks.
 */
export const LEGACY_BLOCK_TYPES = ['heading', 'text', 'button', 'html', 'columns'] as const;

/** The block type that holds other blocks. Nothing else nests. */
export const CONTAINER_TYPE = 'container';

/** Every type the renderer must handle without falling through. */
export const ALL_BLOCK_TYPES = [...BLOCK_TYPES, ...LEGACY_BLOCK_TYPES] as const;

export type BlockType = (typeof ALL_BLOCK_TYPES)[number];
