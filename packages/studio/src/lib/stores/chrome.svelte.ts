/**
 * The three chrome preferences the admin shell persists: sidebar collapse,
 * theme, density.
 *
 * They lived as three `$state` declarations in `(admin)/+layout.svelte`,
 * initialised to their defaults and then read back from localStorage in
 * `onMount`. `onMount` is itself a user effect, so it runs AFTER the `$effect`
 * blocks declared above it — and those effects write the same three keys. Every
 * reload wrote `false` / `light` / `comfortable` over the stored values before
 * anything read them, so none of the three ever survived a refresh.
 *
 * Reading here, at module initialisation, does not answer the ordering question
 * — it removes it. A module body cannot be reordered below an effect, so the
 * defect cannot be reintroduced by moving a line. The layout keeps the effects
 * that persist changes; it no longer owns the initial read.
 */

export type Density = 'comfortable' | 'compact';

function stored(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null; // private mode
  }
}

export const SIDEBAR_KEY = 'zveltio-sidebar';
export const THEME_KEY = 'zveltio-theme';
export const DENSITY_KEY = 'zveltio-density';

export const chrome = $state({
  collapsed: stored(SIDEBAR_KEY) === 'true',
  dark: stored(THEME_KEY) === 'dark',
  density: (stored(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable') as Density,
});
