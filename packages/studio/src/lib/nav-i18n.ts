/**
 * Resolve Paraglide nav keys at render time (locale-reactive when called from $derived).
 */
import { m } from '$lib/i18n.svelte.js';
import type { NavLabelKey } from '$lib/nav-model.js';

export function navLabel(key: NavLabelKey): string {
  const fn = (m as Record<string, (() => string) | undefined>)[key];
  return fn?.() ?? key;
}
