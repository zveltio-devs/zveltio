/**
 * Per-breakpoint block styling.
 *
 * A block's `style` is the base — phone-first, matching how the grid already
 * works. `style_sm` and `style_lg` override it from the tablet and desktop
 * breakpoints, and only for the properties they actually set.
 *
 * NO GENERATED CSS TEXT. The obvious way to do responsive inline styling is to
 * build a `<style>` rule per block and inject it, and that means writing markup
 * out of values an author typed — a colour field is free text, so it is an
 * injection surface reached from the editor and rendered on the public site.
 *
 * Instead each block carries CSS CUSTOM PROPERTIES in its inline style, and one
 * static stylesheet — written once, interpolating nothing — reads them at each
 * breakpoint with the smaller one as the fallback:
 *
 *     .zv-b { padding-top: var(--zv-pt); }
 *     @media (min-width:640px)  { .zv-b { padding-top: var(--zv-pt-sm, var(--zv-pt)); } }
 *     @media (min-width:1024px) { .zv-b { padding-top: var(--zv-pt-lg, var(--zv-pt-sm, var(--zv-pt))); } }
 *
 * Values are still validated here — a number is a number and a colour matches a
 * colour — because a custom property whose value is nonsense is inherited
 * silently rather than ignored loudly.
 */

// biome-ignore lint/suspicious/noExplicitAny: style bags are untyped JSON
type Any = any;

/**
 * The three sizes, named as the editor's device switcher names them so the
 * author's mental model and the stored data use one vocabulary.
 *
 * `base` applies everywhere; `tablet` takes over from 640px, `desktop` from
 * 1024px, and each only for the properties it actually sets.
 */
export const BREAKPOINTS = ['base', 'tablet', 'desktop'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** Which `style*` key holds a given size's values. */
export function styleKey(bp: Breakpoint): string {
  return bp === 'base' ? 'style' : `style_${bp}`;
}

/**
 * Which `col_span*` key holds a given size's width.
 *
 * `col_span` is deliberately the TABLET-and-up width rather than the phone one:
 * that is what it has always meant (`col-span-12 sm:col-span-8`), and changing
 * it would resize every stored page. A phone width is opt-in through
 * `col_span_mobile`.
 */
export function spanKey(bp: Breakpoint): string {
  if (bp === 'base') return 'col_span_mobile';
  if (bp === 'tablet') return 'col_span';
  return 'col_span_desktop';
}

/** Style property → custom-property suffix, and how its value is validated. */
const PROPS: Array<{ key: string; cssVar: string; kind: 'px' | 'color' | 'align' }> = [
  { key: 'paddingTop', cssVar: 'pt', kind: 'px' },
  { key: 'paddingBottom', cssVar: 'pb', kind: 'px' },
  { key: 'paddingLeft', cssVar: 'pl', kind: 'px' },
  { key: 'paddingRight', cssVar: 'pr', kind: 'px' },
  { key: 'marginTop', cssVar: 'mt', kind: 'px' },
  { key: 'marginBottom', cssVar: 'mb', kind: 'px' },
  { key: 'borderRadius', cssVar: 'br', kind: 'px' },
  { key: 'backgroundColor', cssVar: 'bg', kind: 'color' },
  { key: 'textColor', cssVar: 'fg', kind: 'color' },
  { key: 'textAlign', cssVar: 'ta', kind: 'align' },
];

const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|[a-zA-Z]{3,20})$/;
const ALIGN = new Set(['left', 'right', 'center', 'justify']);

function validated(value: unknown, kind: 'px' | 'color' | 'align'): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (kind === 'px') {
    const n = Number(value);
    return Number.isFinite(n) ? `${n}px` : null;
  }
  if (kind === 'color') {
    const s = String(value).trim();
    return COLOR.test(s) ? s : null;
  }
  const s = String(value).trim();
  return ALIGN.has(s) ? s : null;
}

/**
 * The inline `style` attribute for a block: every set property at every
 * breakpoint, as custom properties.
 *
 * Returns undefined when the block styles nothing, so the attribute is left off
 * entirely rather than written empty.
 */
export function styleVars(block: Any): string | undefined {
  const parts: string[] = [];
  for (const bp of BREAKPOINTS) {
    const bag = block?.[styleKey(bp)];
    if (!bag || typeof bag !== 'object') continue;
    const suffix = bp === 'base' ? '' : bp === 'tablet' ? '-sm' : '-lg';
    for (const { key, cssVar, kind } of PROPS) {
      const v = validated(bag[key], kind);
      if (v !== null) parts.push(`--zv-${cssVar}${suffix}:${v}`);
    }
  }
  return parts.length ? parts.join(';') : undefined;
}

/**
 * Whole Tailwind class names for a block's width at each breakpoint.
 *
 * `col-span-${n}` built by interpolation does not exist — Tailwind scans source
 * text for complete names — so every one is spelled out. A block with no
 * per-breakpoint width keeps the same width everywhere, which is what an author
 * who never opened the device switcher expects.
 */
const SPAN_BASE: Record<number, string> = {
  1: 'col-span-1', 2: 'col-span-2', 3: 'col-span-3', 4: 'col-span-4',
  5: 'col-span-5', 6: 'col-span-6', 7: 'col-span-7', 8: 'col-span-8',
  9: 'col-span-9', 10: 'col-span-10', 11: 'col-span-11', 12: 'col-span-12',
};
const SPAN_SM: Record<number, string> = {
  1: 'sm:col-span-1', 2: 'sm:col-span-2', 3: 'sm:col-span-3', 4: 'sm:col-span-4',
  5: 'sm:col-span-5', 6: 'sm:col-span-6', 7: 'sm:col-span-7', 8: 'sm:col-span-8',
  9: 'sm:col-span-9', 10: 'sm:col-span-10', 11: 'sm:col-span-11', 12: 'sm:col-span-12',
};
const SPAN_LG: Record<number, string> = {
  1: 'lg:col-span-1', 2: 'lg:col-span-2', 3: 'lg:col-span-3', 4: 'lg:col-span-4',
  5: 'lg:col-span-5', 6: 'lg:col-span-6', 7: 'lg:col-span-7', 8: 'lg:col-span-8',
  9: 'lg:col-span-9', 10: 'lg:col-span-10', 11: 'lg:col-span-11', 12: 'lg:col-span-12',
};

/**
 * A block's width classes across the three sizes.
 *
 * Phone defaults to full width and tablet to `col_span`, which is exactly what
 * this emitted before breakpoints existed — so a page stored last week looks
 * the same today. Both overrides are opt-in.
 */
export function spanClasses(block: Any): string {
  const mobile = SPAN_BASE[Number(block?.col_span_mobile)];
  const tablet = SPAN_SM[Number(block?.col_span)] ?? SPAN_SM[12];
  const desktop = SPAN_LG[Number(block?.col_span_desktop)];

  return [mobile ?? SPAN_BASE[12], tablet, desktop].filter(Boolean).join(' ');
}
