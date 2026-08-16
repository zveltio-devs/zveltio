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

export interface Block {
  id: string;
  type: string;
  /**
   * A `container` keeps its `children: Block[]` in here, which is why this is
   * the block's whole payload rather than a separate field: the server reads
   * `content`, so anything outside it would not survive a save.
   */
  content: Record<string, any>;
  style?: BlockStyle;
  /**
   * Width in twelfths. This is the layout, and it is the one field the portals
   * migration could not afford to lose: every `zvd_page_views` row carried a
   * `col_span` and a page's arrangement was entirely made of them.
   */
  col_span?: number;
}

export interface LibraryBlock {
  type: string;
  label: string;
  description: string;
  category: 'layout' | 'content' | 'media' | 'zveltio';
  emoji: string;
  defaultContent: Record<string, any>;
}

export const LIBRARY: LibraryBlock[] = [
  // Layout
  {
    type: 'container', label: 'Container', description: 'Holds other blocks side by side',
    category: 'layout', emoji: '⣿',
    defaultContent: { children: [], gap: 'md' },
  },
  {
    type: 'spacer', label: 'Spacer', description: 'Vertical whitespace',
    category: 'layout', emoji: '↕',
    defaultContent: { height: 48 },
  },
  {
    type: 'divider', label: 'Divider', description: 'Horizontal separator',
    category: 'layout', emoji: '─',
    defaultContent: { color: '#e5e7eb', thickness: 1, line_style: 'solid' },
  },
  // Content
  {
    type: 'hero', label: 'Hero', description: 'Full-width hero section',
    category: 'content', emoji: '🖼',
    defaultContent: { title: 'Welcome', subtitle: 'A short description goes here', bg_color: '#1e293b', text_color: '#ffffff', cta_text: 'Get Started', cta_url: '/', image_url: '', overlay_opacity: 40 },
  },
  {
    type: 'richtext', label: 'Rich Text', description: 'Formatted text content',
    category: 'content', emoji: '✏️',
    defaultContent: { content: '<p>Start writing your content here…</p>' },
  },
  {
    type: 'cta', label: 'Call to Action', description: 'CTA banner section',
    category: 'content', emoji: '📢',
    defaultContent: { heading: 'Ready to get started?', text: '', button_text: 'Contact Us', button_url: '/', variant: 'primary' },
  },
  {
    type: 'stats', label: 'Stats', description: 'Key metrics display',
    category: 'content', emoji: '📊',
    defaultContent: { items: [{ value: '100+', label: 'Users' }, { value: '50+', label: 'Projects' }, { value: '99%', label: 'Satisfaction' }, { value: '24/7', label: 'Support' }], columns: 4 },
  },
  // Media
  {
    type: 'image', label: 'Image', description: 'Single image with caption',
    category: 'media', emoji: '🖼',
    defaultContent: { url: '', alt: '', caption: '', link: '' },
  },
  {
    type: 'video', label: 'Video', description: 'YouTube / Vimeo embed',
    category: 'media', emoji: '▶️',
    defaultContent: { url: '', caption: '' },
  },
  {
    type: 'gallery', label: 'Gallery', description: 'Image grid',
    category: 'media', emoji: '⊞',
    defaultContent: { images: [], columns: 3 },
  },
  {
    type: 'embed', label: 'Embed', description: 'Raw HTML / iframe',
    category: 'media', emoji: '</>',
    defaultContent: { html: '' },
  },
  // Zveltio
  {
    type: 'collection_list', label: 'Collection Data', description: 'Live rows from a collection',
    category: 'zveltio', emoji: '⊟',
    defaultContent: { collection: '', view_type: 'list', fields: [], sort_dir: 'desc', limit: 10, title: '' },
  },
];
