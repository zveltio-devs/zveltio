/**
 * A link a block may carry: relative, `#…`, http(s), mailto or tel. Anything
 * else (`javascript:`, `data:`) becomes `#`: a block's URL is authored content,
 * and the kit also serves front ends that do not sanitize it first.
 */
export function safeHref(url: unknown): string {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return '#';
  if (/^(\/(?!\/)|#|\?|\.{1,2}\/)/.test(s)) return s;
  return /^(https?:|mailto:|tel:)/i.test(s) ? s : '#';
}

/** A frame source: http(s) only. */
export function safeFrameSrc(url: unknown): string | null {
  const s = typeof url === 'string' ? url.trim() : '';
  return /^https:\/\//i.test(s) || /^http:\/\//i.test(s) ? s : null;
}

export type LinkVariant = 'primary' | 'secondary' | 'neutral' | 'default' | 'ghost' | 'link';

const VARIANTS: Record<LinkVariant, string> = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-secondary',
  neutral: 'btn btn-neutral',
  default: 'btn',
  ghost: 'btn btn-ghost',
  link: 'btn btn-link',
};

export const linkClass = (v: unknown): string =>
  typeof v === 'string' && Object.hasOwn(VARIANTS, v)
    ? VARIANTS[v as LinkVariant]
    : VARIANTS.primary;
