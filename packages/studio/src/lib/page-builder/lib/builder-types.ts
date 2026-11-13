export type DeviceMode = 'desktop' | 'tablet' | 'mobile';

export interface BlockStyle {
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
  marginTop?: number;
  marginBottom?: number;
  backgroundColor?: string;
  textColor?: string;
  borderRadius?: number;
  textAlign?: 'left' | 'center' | 'right';
}

/**
 * How a block enters and behaves as the visitor scrolls.
 *
 * The editor has written this since the builder was rewired, through
 * `onPatch(b => ({ ...b, motion: { ...(b as any).motion, [key]: value } }))` —
 * the cast is why the write compiled and every READ of `block.motion` did not.
 * The vocabulary is the engine's (`GET /pages/vocabulary` → `MOTION_TYPES`), so
 * `type` is deliberately a plain string rather than a union that would have to be
 * kept in step with a file in the other half of the extension.
 */
export interface BlockMotion {
  type?: string;
  duration?: number;
  delay?: number;
  sticky?: boolean;
  stickyOffset?: number;
}

/**
 * A block's payload: open, because each block type keeps its own properties
 * and the public renderer reads them by name. A container's children are the
 * one property the tree helpers rely on.
 */
export interface BlockContent {
  [k: string]: unknown;
  children?: Block[];
}

export interface Block {
  id: string;
  type: string;
  /**
   * A `container` keeps its `children: Block[]` in here, which is why this is
   * the block's whole payload rather than a separate field: the server reads
   * `content`, so anything outside it would not survive a save.
   */
  content: BlockContent;
  style?: BlockStyle;
  /**
   * Width in twelfths. This is the layout, and it is the one field the portals
   * migration could not afford to lose: every `zvd_page_views` row carried a
   * `col_span` and a page's arrangement was entirely made of them.
   */
  col_span?: number;
  /** Entrance animation and sticky behaviour. See `BlockMotion`. */
  motion?: BlockMotion;
  /**
   * A block carries fields this interface does not name.
   *
   * `block-tree.ts` declared its own `TreeBlock` with an index signature for
   * exactly that reason, and the two types then refused to assign to each other
   * — six errors in `BlockList.svelte` alone, all of the form "TreeBlock is not
   * assignable to Block". Two declarations of one concept do not merely annoy
   * the compiler: any REAL divergence between them is invisible, because the
   * error is already there and already ignored.
   *
   * `TreeBlock` is now an alias of this type, so there is one shape.
   */
  /** The per-size bags `styleKey`/`spanKey` name (`style_tablet`, `col_span_desktop`). */
  [k: string]: unknown;
}

export interface LibraryBlock {
  type: string;
  label: string;
  description: string;
  category: 'layout' | 'content' | 'media' | 'zveltio';
  emoji: string;
  defaultContent: BlockContent;
}

export const LIBRARY: LibraryBlock[] = [
  // Layout
  {
    type: 'container',
    label: 'Container',
    description: 'Holds other blocks side by side',
    category: 'layout',
    emoji: '⣿',
    defaultContent: { children: [], gap: 'md' },
  },
  {
    type: 'spacer',
    label: 'Spacer',
    description: 'Vertical whitespace',
    category: 'layout',
    emoji: '↕',
    defaultContent: { height: 48 },
  },
  {
    type: 'divider',
    label: 'Divider',
    description: 'Horizontal separator',
    category: 'layout',
    emoji: '─',
    defaultContent: { color: '#e5e7eb', thickness: 1, line_style: 'solid' },
  },
  // Content
  {
    type: 'hero',
    label: 'Hero',
    description: 'Full-width hero section',
    category: 'content',
    emoji: '🖼',
    defaultContent: {
      title: 'Welcome',
      subtitle: 'A short description goes here',
      bg_color: '#1e293b',
      text_color: '#ffffff',
      cta_text: 'Get Started',
      cta_url: '/',
      image_url: '',
      overlay_opacity: 40,
    },
  },
  {
    type: 'richtext',
    label: 'Rich Text',
    description: 'Formatted text content',
    category: 'content',
    emoji: '✏️',
    defaultContent: { content: '<p>Start writing your content here…</p>' },
  },
  {
    type: 'cta',
    label: 'Call to Action',
    description: 'CTA banner section',
    category: 'content',
    emoji: '📢',
    defaultContent: {
      heading: 'Ready to get started?',
      text: '',
      button_text: 'Contact Us',
      button_url: '/',
      variant: 'primary',
    },
  },
  {
    type: 'stats',
    label: 'Stats',
    description: 'Key metrics display',
    category: 'content',
    emoji: '📊',
    defaultContent: {
      items: [
        { value: '100+', label: 'Users' },
        { value: '50+', label: 'Projects' },
        { value: '99%', label: 'Satisfaction' },
        { value: '24/7', label: 'Support' },
      ],
      columns: 4,
    },
  },
  // Media
  {
    type: 'image',
    label: 'Image',
    description: 'Single image with caption',
    category: 'media',
    emoji: '🖼',
    defaultContent: { url: '', alt: '', caption: '', link: '' },
  },
  {
    type: 'video',
    label: 'Video',
    description: 'YouTube / Vimeo embed',
    category: 'media',
    emoji: '▶️',
    defaultContent: { url: '', caption: '' },
  },
  {
    type: 'gallery',
    label: 'Gallery',
    description: 'Image grid',
    category: 'media',
    emoji: '⊞',
    defaultContent: { images: [], columns: 3 },
  },
  {
    type: 'embed',
    label: 'Embed',
    description: 'Raw HTML / iframe',
    category: 'media',
    emoji: '</>',
    defaultContent: { html: '' },
  },
  {
    type: 'icon',
    label: 'Icon',
    description: 'A single icon at any size',
    category: 'media',
    emoji: '★',
    defaultContent: { name: 'star', size: 32, label: '' },
  },
  {
    type: 'button',
    label: 'Button',
    description: 'A link styled as a button',
    category: 'content',
    emoji: '▭',
    defaultContent: { label: 'Click here', href: '/', variant: 'primary' },
  },
  // Zveltio
  {
    type: 'collection_list',
    label: 'Collection Data',
    description: 'Live rows from a collection',
    category: 'zveltio',
    emoji: '⊟',
    defaultContent: {
      collection: '',
      view_type: 'list',
      fields: [],
      sort_dir: 'desc',
      limit: 10,
      title: '',
    },
  },
];

/** One figure of a `stats` block. */
export interface StatItem {
  value?: string;
  label?: string;
}

/** One picture of a `gallery` block. */
export interface GalleryImage {
  url: string;
  alt?: string;
}

/** One condition of a data block, in the engine's operator vocabulary. */
export interface ContentFilter {
  field: string;
  op: string;
  value?: unknown;
}

/**
 * The properties the canvas and the properties panel read, by name. A block
 * holds only those of its own type; every one is optional because an author
 * may not have set it yet, and the stored JSON may predate it.
 */
export interface BlockFields {
  alt?: string;
  bg_color?: string;
  button_text?: string;
  button_url?: string;
  caption?: string;
  children?: Block[];
  collection?: string;
  color?: string;
  columns?: number;
  content?: string;
  count?: number;
  cta_text?: string;
  cta_url?: string;
  fields?: string[];
  filters?: ContentFilter[];
  gap?: string;
  heading?: string;
  height?: number;
  href?: string;
  html?: string;
  image_url?: string;
  images?: GalleryImage[];
  item_template?: BlockContent | null;
  /** `stats` keeps `StatItem`s here, legacy `columns` keeps HTML strings. */
  items?: unknown[];
  label?: string;
  limit?: number;
  line_style?: string;
  link?: string;
  name?: string;
  overlay_opacity?: number;
  size?: number;
  sort_dir?: string;
  sort_field?: string;
  subtitle?: string;
  text?: string;
  text_color?: string;
  thickness?: number;
  title?: string;
  url?: string;
  variant?: string;
  view_type?: string;
}

/** A block's payload read as the properties the builder knows. */
export function fieldsOf(block: Block): BlockFields {
  return block.content as BlockFields;
}

/** One `stats` entry read as a figure; anything else reads as an empty one. */
export function asStat(item: unknown): StatItem {
  return typeof item === 'object' && item !== null ? (item as StatItem) : {};
}

/** One legacy `columns` entry read as its HTML, as the public renderer reads it. */
export function asText(item: unknown): string {
  return typeof item === 'string' ? item : String(item ?? '');
}
