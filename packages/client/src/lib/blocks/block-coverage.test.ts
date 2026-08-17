/**
 * Every block type the builder can author must DRAW here.
 *
 * The renderer and the block library drifted for three months and nothing
 * compared them: a page built from the full library came out of this component
 * as ten "Unsupported block" placeholders and one `<hr>`, and `image` drew
 * nothing because the builder writes `content.url` while this read `content.src`.
 *
 * The extension holds the matching source-level gate (`block-contract.test.ts`);
 * this one renders, so a type that is handled but throws or draws nothing still
 * fails.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import BlockRenderer from './BlockRenderer.svelte';
import { ALL_BLOCK_TYPES } from '$lib/ext/content/pages/block-types';

// One representative block per type, in the shape the builder actually writes.
const SAMPLES: Record<string, Record<string, unknown>> = {
  container: {
    gap: 'md',
    children: [{ id: 'kid', type: 'richtext', content: { content: '<p>nested</p>' } }],
  },
  hero: { title: 'Hero title', subtitle: 'sub' },
  richtext: { content: '<p>Body copy</p>' },
  image: { url: 'https://example.test/a.png', alt: 'a' },
  columns: { count: 2, items: ['<p>col one</p>', '<p>col two</p>'] },
  cta: { heading: 'CTA heading', button_text: 'Press', button_url: '/x' },
  stats: { items: [{ value: '99%', label: 'Uptime' }], columns: 4 },
  embed: { html: '<b>embedded</b>' },
  spacer: { height: 48 },
  video: { url: 'https://player.test/1' },
  gallery: { images: [{ url: 'https://example.test/g.png', alt: 'g' }] },
  divider: {},
  icon: { name: 'star', size: 32, label: 'Featured' },
  collection_list: {
    collection: 'contacts',
    view_type: 'table',
    title: 'Team',
    display_fields: 'first_name,email',
    _data: [{ first_name: 'Ana', email: 'ana@example.test' }],
  },
  heading: { level: 2, text: 'Legacy heading' },
  text: { html: '<p>Legacy text</p>' },
  button: { label: 'Press me', href: '/b', variant: 'primary' },
  html: { code: '<p>Legacy html</p>' },
};

describe('block coverage', () => {
  afterEach(() => cleanup());

  it('no type falls through to the placeholder', () => {
    const blocks = ALL_BLOCK_TYPES.map((type, i) => ({
      id: String(i),
      type,
      content: SAMPLES[type] ?? {},
    }));
    const { container } = render(BlockRenderer, { props: { blocks } });
    const unsupported = [...container.innerHTML.matchAll(/Unsupported block: (\w+)/g)].map(
      (m) => m[1],
    );
    expect(unsupported).toEqual([]);
  });

  it('every type has a sample, so the check above is not vacuous', () => {
    expect(ALL_BLOCK_TYPES.filter((t) => !SAMPLES[t])).toEqual([]);
  });

  it('a data block draws its rows, headers included', () => {
    const { container } = render(BlockRenderer, {
      props: { blocks: [{ id: '1', type: 'collection_list', content: SAMPLES.collection_list }] },
    });
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.innerHTML).toContain('ana@example.test');
    // `first_name` is humanised for the column header.
    expect(container.innerHTML).toContain('First name');
  });

  it('a data block the caller may not read shows the refusal, not an empty table', () => {
    const { container } = render(BlockRenderer, {
      props: {
        blocks: [
          {
            id: '1',
            type: 'collection_list',
            content: {
              collection: 'contacts',
              _data: [],
              _error: 'This collection is not published on this site',
            },
          },
        ],
      },
    });
    expect(container.innerHTML).toContain('not published on this site');
    expect(container.querySelector('table')).toBeNull();
  });

  it('col_span becomes a real grid class', () => {
    const { container } = render(BlockRenderer, {
      props: {
        blocks: [
          { id: '1', type: 'divider', col_span: 8, content: {} },
          { id: '2', type: 'divider', col_span: 4, content: {} },
        ],
      },
    });
    expect(container.innerHTML).toContain('sm:col-span-8');
    expect(container.innerHTML).toContain('sm:col-span-4');
  });

  it('authored script markup never survives into the page', () => {
    const { container } = render(BlockRenderer, {
      props: {
        blocks: [
          { id: '1', type: 'richtext', content: { content: '<p>ok</p><script>alert(1)</script>' } },
          { id: '2', type: 'embed', content: { html: '<img src=x onerror=alert(2)>' } },
        ],
      },
    });
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('alert(1)');
    expect(container.innerHTML).not.toContain('onerror');
  });
});

describe('icons and motion', () => {
  afterEach(() => cleanup());

  it('an icon block draws an svg and its label', () => {
    const { container } = render(BlockRenderer, {
      props: {
        blocks: [
          { id: '1', type: 'icon', content: { name: 'heart', size: 40, label: 'Favourites' } },
        ],
      },
    });
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('width')).toBe('40');
    expect(container.textContent).toContain('Favourites');
  });

  it('an unknown icon name draws nothing rather than a broken glyph', () => {
    const { container } = render(BlockRenderer, {
      props: { blocks: [{ id: '1', type: 'icon', content: { name: 'not-an-icon' } }] },
    });
    expect(container.querySelector('svg')).toBeNull();
    expect(container.innerHTML).not.toContain('Unsupported block');
  });

  it('an icon with no label is hidden from assistive technology', () => {
    const { container } = render(BlockRenderer, {
      props: { blocks: [{ id: '1', type: 'icon', content: { name: 'star' } }] },
    });
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('motion becomes a class and timing variables', () => {
    const { container } = render(BlockRenderer, {
      props: {
        blocks: [
          {
            id: '1',
            type: 'divider',
            content: {},
            motion: { type: 'up', duration: 600, delay: 100 },
          },
        ],
      },
    });
    const el = container.querySelector('.zv-anim') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.className).toContain('zv-anim-up');
    // Read off the element rather than the HTML string: the DOM normalises
    // custom properties to `--x: 600ms` with a space.
    expect(el.style.getPropertyValue('--zv-anim-dur').trim()).toBe('600ms');
    expect(el.style.getPropertyValue('--zv-anim-delay').trim()).toBe('100ms');
  });

  it('without IntersectionObserver every block is revealed, not hidden', () => {
    // jsdom has no observer, which is the same situation as a browser where the
    // script failed. The fallback marks everything seen — an animation library
    // that leaves the page blank in that case is the failure being avoided.
    const { container } = render(BlockRenderer, {
      props: { blocks: [{ id: '1', type: 'divider', content: {}, motion: { type: 'fade' } }] },
    });
    expect(container.querySelector('.zv-anim')?.className).toContain('zv-seen');
  });

  it('a block with no motion carries no animation class', () => {
    const { container } = render(BlockRenderer, {
      props: { blocks: [{ id: '1', type: 'divider', content: {} }] },
    });
    expect(container.innerHTML).not.toContain('zv-anim');
  });
});

describe('nesting', () => {
  afterEach(() => cleanup());

  it('a container draws its children, at any depth', () => {
    const { container } = render(BlockRenderer, {
      props: {
        blocks: [
          {
            id: '1',
            type: 'container',
            col_span: 12,
            content: {
              gap: 'lg',
              children: [
                {
                  id: '1a',
                  type: 'richtext',
                  col_span: 8,
                  content: { content: '<p>Left column</p>' },
                },
                {
                  id: '1b',
                  type: 'container',
                  col_span: 4,
                  content: {
                    children: [
                      {
                        id: '1b1',
                        type: 'collection_list',
                        content: {
                          collection: 'contacts',
                          view_type: 'table',
                          display_fields: 'first_name',
                          _data: [{ first_name: 'Deep' }],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const html = container.innerHTML;
    expect(html).toContain('Left column');
    // Two levels down, the data block still draws its table.
    expect(html).toContain('Deep');
    expect(container.querySelector('table')).not.toBeNull();
    expect(html).not.toContain('Unsupported block');
  });

  it("a child's col_span applies inside the container, not just at the top", () => {
    const { container } = render(BlockRenderer, {
      props: {
        blocks: [
          {
            id: '1',
            type: 'container',
            content: {
              children: [
                { id: 'a', type: 'divider', col_span: 8, content: {} },
                { id: 'b', type: 'divider', col_span: 4, content: {} },
              ],
            },
          },
        ],
      },
    });
    expect(container.innerHTML).toContain('sm:col-span-8');
    expect(container.innerHTML).toContain('sm:col-span-4');
  });

  it('the retired columns block still renders on stored pages', () => {
    const { container } = render(BlockRenderer, {
      props: {
        blocks: [
          {
            id: '1',
            type: 'columns',
            content: { count: 2, items: ['<p>old one</p>', '<p>old two</p>'] },
          },
        ],
      },
    });
    expect(container.innerHTML).toContain('old one');
    expect(container.innerHTML).toContain('old two');
    expect(container.innerHTML).not.toContain('Unsupported block');
  });
});

describe('item template', () => {
  afterEach(() => cleanup());

  const TEMPLATE_BLOCK = {
    id: 'list',
    type: 'collection_list',
    content: {
      collection: 'contacts',
      view_type: 'template',
      item_template: {
        id: 'card',
        type: 'container',
        col_span: 6,
        content: {
          gap: 'sm',
          children: [
            {
              id: 'name',
              type: 'richtext',
              content: { content: '<h3>{{first_name}} {{last_name}}</h3>' },
            },
            {
              id: 'mail',
              type: 'button',
              content: { label: 'Write to {{first_name}}', href: 'mailto:{{email}}' },
            },
          ],
        },
      },
      _data: [
        { first_name: 'Ana', last_name: 'Pop', email: 'ana@example.test' },
        { first_name: 'Dan', last_name: 'Ion', email: 'dan@example.test' },
      ],
    },
  };

  it('draws the template once per record, with each record’s values', () => {
    const { container } = render(BlockRenderer, { props: { blocks: [TEMPLATE_BLOCK] } });
    const html = container.innerHTML;
    expect(html).toContain('Ana Pop');
    expect(html).toContain('Dan Ion');
    expect(html).toContain('Write to Ana');
    expect(html).toContain('Write to Dan');
    expect(container.querySelectorAll('h3')).toHaveLength(2);
    // No placeholder is left on the page.
    expect(html).not.toContain('{{');
  });

  it('binds attributes as well as text', () => {
    const { container } = render(BlockRenderer, { props: { blocks: [TEMPLATE_BLOCK] } });
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('mailto:ana@example.test');
    expect(hrefs).toContain('mailto:dan@example.test');
  });

  it("honours the template's col_span, so items sit side by side", () => {
    const { container } = render(BlockRenderer, { props: { blocks: [TEMPLATE_BLOCK] } });
    expect(container.innerHTML).toContain('sm:col-span-6');
  });

  it('a record value can never inject markup, however hostile', () => {
    const hostile = {
      ...TEMPLATE_BLOCK,
      content: {
        ...TEMPLATE_BLOCK.content,
        _data: [{ first_name: '<img src=x onerror=alert(1)>', last_name: '', email: 'x' }],
      },
    };
    const { container } = render(BlockRenderer, { props: { blocks: [hostile] } });
    // No element was created from the value — it lands inside a {@html} property
    // and is escaped before it gets there.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // The reader still SEES what the record says, as text.
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a value shown as plain text is not double-escaped', () => {
    // Escaping in both `bind` and Svelte's text node would print `&lt;b&gt;` to
    // the reader where the record says `<b>`.
    const withMarkupValue = {
      ...TEMPLATE_BLOCK,
      content: {
        ...TEMPLATE_BLOCK.content,
        _data: [{ first_name: 'R&D', last_name: '', email: 'x' }],
      },
    };
    const { container } = render(BlockRenderer, { props: { blocks: [withMarkupValue] } });
    expect(container.textContent).toContain('Write to R&D');
    expect(container.textContent).not.toContain('&amp;');
  });

  it('falls back to a normal layout when no template is set', () => {
    const { container } = render(BlockRenderer, {
      props: {
        blocks: [
          {
            id: 'l',
            type: 'collection_list',
            content: {
              collection: 'contacts',
              view_type: 'template',
              display_fields: 'first_name',
              _data: [{ first_name: 'Ana' }],
            },
          },
        ],
      },
    });
    // No `item_template`, so `renderItem` is undefined and the list layout draws.
    expect(container.innerHTML).toContain('Ana');
    expect(container.innerHTML).not.toContain('Unsupported block');
  });

  it('a refusal is shown instead of N empty templates', () => {
    const { container } = render(BlockRenderer, {
      props: {
        blocks: [
          {
            ...TEMPLATE_BLOCK,
            content: {
              ...TEMPLATE_BLOCK.content,
              _data: [],
              _error: 'Not permitted to read this collection',
            },
          },
        ],
      },
    });
    expect(container.innerHTML).toContain('Not permitted');
    expect(container.querySelectorAll('h3')).toHaveLength(0);
  });
});
