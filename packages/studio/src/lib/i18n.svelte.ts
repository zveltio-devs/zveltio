/**
 * i18n helper (S5-10). Wraps Paraglide JS's runtime with a Svelte 5
 * reactive `locale` so components re-render when the user switches
 * language. Defaults to the value persisted in localStorage, falling
 * back to the browser's `navigator.language`, then to the project's
 * `baseLocale` (en).
 *
 * Usage in a component:
 *
 *   <script lang="ts">
 *     import { m, i18n } from '$lib/i18n.svelte.js';
 *   </script>
 *
 *   <h1>{m['account.profile']()}</h1>
 *   <button onclick={() => i18n.setLocale('ro')}>Română</button>
 *
 * Adding a new string:
 *   1. Edit messages/core/{locale}.json and/or extension studio/messages/{locale}.json.
 *   2. Run `bun run i18n:compile` (merge + compile). Locales: en, ro, fr, de.
 *   See packages/studio/messages/README.md.
 *
 * `paraglide-js` is invoked via the package.json script — wire into CI
 * once we want to fail builds when messages are missing translations.
 */

// The generated runtime exposes `m` (typed message accessors), `getLocale`,
// `setLocale`, and `locales`. Paraglide emits JS without .d.ts in compile
// output, so we relax to `any` and trust runtime correctness — the compile
// step (`bun run i18n:compile`) catches every breakage at message-key
// level when a message is missing from one of the locales.
// @ts-ignore — runtime is JS-only output from paraglide-js compile
import * as paraglide from './paraglide/runtime.js';
// @ts-ignore — runtime is JS-only output from paraglide-js compile
import * as messages from './paraglide/messages.js';

const STORAGE_KEY = 'zveltio-locale';

function detectInitialLocale(): string {
  if (typeof window === 'undefined') return paraglide.baseLocale;
  // Persisted user choice wins.
  const stored = (() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  })();
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  if (stored && paraglide.locales.includes(stored as any)) return stored;
  // Browser-Detected fallback.
  const nav = (navigator?.language ?? '').split('-')[0];
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  if (nav && paraglide.locales.includes(nav as any)) return nav;
  return paraglide.baseLocale;
}

let _locale = $state<string>(detectInitialLocale());

// Push the initial locale into the Paraglide runtime so `m.*()` calls
// resolve correctly from the very first render.
if (typeof window !== 'undefined') {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    paraglide.setLocale(_locale as any, { reload: false });
  } catch {
    /* paraglide >=2.0 doesn't take a reload option; fall through */
  }
}

export const i18n = {
  /** Current locale id, e.g. 'en' or 'ro'. Reactive. */
  get locale() {
    return _locale;
  },
  /** List of locales the project ships translations for. */
  get availableLocales(): readonly string[] {
    return paraglide.locales as unknown as readonly string[];
  },
  /** Persist + apply a new locale. */
  setLocale(next: string): void {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    if (!paraglide.locales.includes(next as any)) {
      console.warn(`[i18n] unknown locale "${next}"; available: ${paraglide.locales.join(', ')}`);
      return;
    }
    _locale = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* */
    }
    try {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      paraglide.setLocale(next as any, { reload: false });
    } catch {
      /* paraglide >= 2 — newer API */ try {
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        paraglide.setLocale(next as any);
      } catch {
        /* */
      }
    }
  },
};

/**
 * Typed message accessors. Each property is a function that returns the
 * translated string for the current locale.
 *
 *   m['common.save']()           // "Save" / "Salvează"
 *   m['passkey.empty']({ action: 'Add passkey' })
 */
export const m = messages;
