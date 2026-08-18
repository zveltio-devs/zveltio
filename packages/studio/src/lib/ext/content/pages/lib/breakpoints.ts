/**
 * Which stored key holds a block's width and styling at each device size.
 *
 * The editor's copy. The renderer's is `client/responsive.ts`, and the two must
 * agree exactly — the editor writes these keys and the renderer reads them, so a
 * disagreement means the author sets a value that nothing applies.
 *
 * Duplicated on purpose, and it is the ONLY thing duplicated: a file under
 * `studio/src/` cannot import outside it, because the sync that copies extension
 * pages into the Studio strips that prefix and any escaping path breaks. Rather
 * than machinery in two build systems for six lines, the two copies are held
 * together by `client/breakpoint-parity.test.ts`, which reads both off disk and
 * fails if they drift — the same arrangement that keeps the block vocabularies
 * in step.
 */

export const BREAKPOINTS = ['base', 'tablet', 'desktop'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** Human label for the device switcher. */
export const BREAKPOINT_LABEL: Record<Breakpoint, string> = {
  base: 'All sizes',
  tablet: 'Tablet and up',
  desktop: 'Desktop',
};

export function styleKey(bp: Breakpoint): string {
  return bp === 'base' ? 'style' : `style_${bp}`;
}

/**
 * `col_span` is the TABLET key, not the phone one — that is what it has always
 * meant, and renaming it would resize every stored page.
 */
export function spanKey(bp: Breakpoint): string {
  if (bp === 'base') return 'col_span_mobile';
  if (bp === 'tablet') return 'col_span';
  return 'col_span_desktop';
}
