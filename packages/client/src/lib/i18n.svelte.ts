/**
 * i18n for the client portal.
 *
 * Mirrors `packages/studio/src/lib/i18n.svelte.ts`: Paraglide's generated
 * runtime wrapped in a Svelte 5 reactive `locale`, so switching language
 * re-renders rather than requiring a reload.
 *
 * The catalogue existed before this file did. `messages/en.json` and
 * `messages/ro.json` were committed with eleven keys and never imported
 * anywhere — an audit found zero references in `src/`, so every string in the
 * portal was hard-coded English while the repository looked translated. The
 * eleven keys were also the wrong eleven: they named things like `dashboard`
 * and `welcome`, none of which appeared in the markup. They have been dropped
 * rather than translated, and the catalogue now covers the strings the portal
 * actually renders, in the same nine locales the Studio ships.
 *
 * Usage:
 *
 *   <script lang="ts">
 *     import { m, i18n } from '$lib/i18n.svelte.js';
 *   </script>
 *
 *   <h1>{m['auth.sign_in']()}</h1>
 *
 * Adding a string: edit `messages/{locale}.json` for all nine, then
 * `bun run i18n:compile`. `prebuild` runs it, so a build can never ship
 * against a stale catalogue.
 */

// Paraglide emits JS without .d.ts, so the runtime is untyped here. The compile
// step is what catches a key missing from a locale, which is the failure that
// matters — a typo in a key name surfaces as a missing-message error at build.
// @ts-ignore — runtime is JS-only output from paraglide-js compile
import * as paraglide from './paraglide/runtime.js';

/**
 * Paraglide types its locale as a literal union, while everything reaching this
 * module — localStorage, `navigator.language`, a caller — is a plain string.
 * The membership check is `paraglide.locales.includes(...)`, which narrows at
 * runtime but not for the compiler, so the cast sits behind that check rather
 * than in front of it.
 */
type Locale = Parameters<typeof paraglide.setLocale>[0];
// @ts-ignore — runtime is JS-only output from paraglide-js compile
import * as messages from './paraglide/messages.js';

const STORAGE_KEY = 'zveltio-locale';

/**
 * Persisted choice, then the browser's preference, then the base locale.
 *
 * Guarded on `window` because the client is a SvelteKit app that prerenders:
 * touching localStorage during SSR throws, and the server has no user to have a
 * preference anyway.
 */
function detectInitialLocale(): string {
  if (typeof window === 'undefined') return paraglide.baseLocale;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && paraglide.locales.includes(stored as Locale)) return stored;
  } catch {
    /* storage blocked (private mode, embedded webview) — fall through */
  }

  // `navigator.language` is a full tag ("ro-RO"); the catalogue is keyed by the
  // primary subtag.
  const browser = navigator.language?.split('-')[0];
  if (browser && paraglide.locales.includes(browser as Locale)) return browser;

  return paraglide.baseLocale;
}

class I18n {
  locale = $state(detectInitialLocale());

  constructor() {
    // Tell Paraglide about the resolved locale before anything renders, or the
    // first paint uses the base locale and then flips.
    if (typeof window !== 'undefined')
      paraglide.setLocale(this.locale as Locale, { reload: false });
  }

  setLocale(next: string): void {
    if (!paraglide.locales.includes(next as Locale)) return;
    this.locale = next;
    paraglide.setLocale(next as Locale, { reload: false });
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage blocked — the choice simply does not persist */
    }
  }

  get locales(): readonly string[] {
    return paraglide.locales;
  }
}

export const i18n = new I18n();

/**
 * Message accessors, keyed by the dotted name used in the catalogue.
 *
 * Paraglide compiles `auth.sign_in` to an identifier it can export, so the
 * lookup goes through this map rather than property access on the module.
 */
// biome-ignore lint/suspicious/noExplicitAny: generated module has no types
export const m: Record<string, (...args: any[]) => string> = messages as any;
