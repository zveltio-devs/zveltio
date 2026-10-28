/**
 * Apply a theme (ADR 0007): a few daisyUI 5 tokens held as data, turned into
 * the CSS variables daisyUI already reads. No second token layer.
 *
 * The engine validates a theme when it is written; this checks every value
 * again, because the result lands in a style attribute and the kit also serves
 * front ends whose theme did not come from the engine. A value that is not a
 * colour, a length or a known name is dropped, not escaped.
 */

export const THEME_COLORS = [
  'primary',
  'primary-content',
  'secondary',
  'secondary-content',
  'accent',
  'accent-content',
  'neutral',
  'neutral-content',
  'base-100',
  'base-200',
  'base-300',
  'base-content',
  'info',
  'info-content',
  'success',
  'success-content',
  'warning',
  'warning-content',
  'error',
  'error-content',
] as const;

export type ThemeColor = (typeof THEME_COLORS)[number];

export interface Theme {
  scheme?: 'light' | 'dark';
  colors?: Partial<Record<ThemeColor, string>>;
  radius?: { selector?: string; field?: string; box?: string };
  border?: string;
  font?: 'system' | 'sans' | 'serif' | 'mono';
  density?: 'compact' | 'normal' | 'comfortable';
}

// Same patterns as `packages/engine/src/lib/theme.ts`, which checks at write.
const COLOR =
  /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|oklch\(\d{1,3}(\.\d{1,4})?%? \d(\.\d{1,4})? \d{1,3}(\.\d{1,4})?\))$/i;
const LENGTH = /^(0|\d{1,2}(\.\d{1,4})?(rem|px))$/;

const FONTS: Record<NonNullable<Theme['font']>, string> = {
  system: 'system-ui, sans-serif',
  sans: 'ui-sans-serif, system-ui, sans-serif',
  serif: 'ui-serif, Georgia, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

// daisyUI's own defaults are 0.25rem for both; one step either way.
const DENSITY: Record<NonNullable<Theme['density']>, string> = {
  compact: '0.21875rem',
  normal: '0.25rem',
  comfortable: '0.28125rem',
};

const ok = (re: RegExp, v: unknown): v is string => typeof v === 'string' && re.test(v);

/** The CSS variables a theme sets; anything invalid is left out. */
export function themeVars(theme: Theme | null | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!theme || typeof theme !== 'object') return vars;
  for (const k of THEME_COLORS) {
    const v = theme.colors?.[k];
    if (ok(COLOR, v)) vars[`--color-${k}`] = v;
  }
  for (const k of ['selector', 'field', 'box'] as const) {
    const v = theme.radius?.[k];
    if (ok(LENGTH, v)) vars[`--radius-${k}`] = v;
  }
  if (ok(LENGTH, theme.border)) vars['--border'] = theme.border;
  const font = theme.font && Object.hasOwn(FONTS, theme.font) ? FONTS[theme.font] : null;
  if (font) vars['--font-sans'] = font;
  const size =
    theme.density && Object.hasOwn(DENSITY, theme.density) ? DENSITY[theme.density] : null;
  if (size) {
    vars['--size-field'] = size;
    vars['--size-selector'] = size;
  }
  return vars;
}

/** The same, as a `style` attribute value. */
export function themeStyle(theme: Theme | null | undefined): string {
  return Object.entries(themeVars(theme))
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}

/** daisyUI's base theme to start from: the one named by `scheme`, else none. */
export function themeName(theme: Theme | null | undefined): 'light' | 'dark' | undefined {
  return theme?.scheme === 'dark' || theme?.scheme === 'light' ? theme.scheme : undefined;
}
