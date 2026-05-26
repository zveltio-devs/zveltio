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
  props: Record<string, any>;
  style?: BlockStyle;
}

export interface LibraryBlock {
  type: string;
  label: string;
  description: string;
  category: 'layout' | 'content' | 'media' | 'zveltio';
  emoji: string;
  defaultProps: Record<string, any>;
}

export const LIBRARY: LibraryBlock[] = [
  // Layout
  {
    type: 'columns',
    label: 'Columns',
    description: '2–4 column grid',
    category: 'layout',
    emoji: '⣿',
    defaultProps: { count: 2, items: ['<p>Column 1</p>', '<p>Column 2</p>'] },
  },
  {
    type: 'spacer',
    label: 'Spacer',
    description: 'Vertical whitespace',
    category: 'layout',
    emoji: '↕',
    defaultProps: { height: 48 },
  },
  {
    type: 'divider',
    label: 'Divider',
    description: 'Horizontal separator',
    category: 'layout',
    emoji: '─',
    defaultProps: { color: '#e5e7eb', thickness: 1, line_style: 'solid' },
  },
  // Content
  {
    type: 'hero',
    label: 'Hero',
    description: 'Full-width hero section',
    category: 'content',
    emoji: '🖼',
    defaultProps: {
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
    defaultProps: { content: '<p>Start writing your content here…</p>' },
  },
  {
    type: 'cta',
    label: 'Call to Action',
    description: 'CTA banner section',
    category: 'content',
    emoji: '📢',
    defaultProps: {
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
    defaultProps: {
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
    defaultProps: { url: '', alt: '', caption: '', link: '' },
  },
  {
    type: 'video',
    label: 'Video',
    description: 'YouTube / Vimeo embed',
    category: 'media',
    emoji: '▶️',
    defaultProps: { url: '', caption: '' },
  },
  {
    type: 'gallery',
    label: 'Gallery',
    description: 'Image grid',
    category: 'media',
    emoji: '⊞',
    defaultProps: { images: [], columns: 3 },
  },
  {
    type: 'embed',
    label: 'Embed',
    description: 'Raw HTML / iframe',
    category: 'media',
    emoji: '</>',
    defaultProps: { html: '' },
  },
  // Zveltio
  {
    type: 'data_table',
    label: 'Data Table',
    description: 'Live collection data',
    category: 'zveltio',
    emoji: '⊟',
    defaultProps: { collection: '', fields: [], limit: 10, title: '' },
  },
];
