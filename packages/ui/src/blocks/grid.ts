/**
 * Column counts as whole class names: Tailwind generates only class names it
 * finds complete in source, so an interpolated `sm:grid-cols-${n}` collapses
 * the grid to one column.
 */
const COLS = [
  '',
  'sm:grid-cols-1',
  'sm:grid-cols-2',
  'sm:grid-cols-3',
  'sm:grid-cols-4',
  'sm:grid-cols-5',
  'sm:grid-cols-6',
];

export const colsClass = (n: unknown, fallback: number, max = 6): string =>
  COLS[Math.min(Math.max(Math.trunc(Number(n)) || fallback, 1), max)];

export const GAPS = { none: 'gap-0', sm: 'gap-2', md: 'gap-6', lg: 'gap-10' } as const;
export type Gap = keyof typeof GAPS;
