/**
 * Studio extension API (S3-02 + S3-03).
 *
 * This module is the single source of truth for what extensions can do
 * inside Studio at runtime. It owns three reactive registries:
 *
 *   - `routes` — extension-contributed top-level pages (existing
 *     `window.__zveltio.registerRoute` flow).
 *   - `slots` — named composition points scattered across core Studio
 *     pages. Extensions register components targeting a slot name, and
 *     `<Slot name="...">` walks the list at render.
 *   - `form alters` — Drupal-style hooks that mutate a form schema
 *     before render. Extensions add fields, hide fields, attach
 *     validators.
 *
 * Bundle authors interact via the global `window.__zveltio` (see
 * `bundle-loader.ts` for the load-and-execute path). Core Studio code
 * imports the typed registries directly from this module.
 *
 * Why one file: keeping the registries co-located avoids accidental
 * fan-out — every new extension-facing surface goes through this same
 * pattern. The `@zveltio/sdk/studio` package (S4-07) will eventually be
 * a thin re-export of these types so extensions can `import` instead of
 * touching `window`.
 */

import type {
  StudioRoute,
  SlotContribution,
  FormAlterHook,
  FormSchema,
} from '@zveltio/sdk/extension';
import { applyFormAlterHooks, sortSlotContributions, makeFormProxy } from '@zveltio/sdk/studio';

// ── Routes ──────────────────────────────────────────────────────────────────
// Existing API, formalized here so all three registries share shape.

const _routes = $state<StudioRoute[]>([]);

// ── Slots ───────────────────────────────────────────────────────────────────
// Keyed by slot name. Contributions sort by priority asc on read so adding
// to the array is O(1); render-side cost is once-per-render.

const _slots = $state<Record<string, SlotContribution[]>>({});

// ── Form alters ─────────────────────────────────────────────────────────────
// Keyed by form id. The id is a stable string declared by the form's
// renderer (e.g. `core:user-edit`, `collection:zvd_contacts:edit`).

const _formAlters = $state<Record<string, FormAlterHook[]>>({});

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Reactive view of every contribution. UI code should read these and let
 * Svelte 5's `$derived` re-run when extensions register late.
 */
export const studioApi = {
  get routes() {
    return _routes;
  },
  get slots() {
    return _slots;
  },
  get formAlters() {
    return _formAlters;
  },
  /** Slot consumers — `<Slot name>` calls this. */
  getSlotContributions(name: string): SlotContribution[] {
    const list = _slots[name];
    if (!list || list.length === 0) return [];
    return sortSlotContributions(list);
  },
  /** Form renderers — call this once before render to get the altered schema. */
  applyFormAlters(formId: string, schema: FormSchema, ctx?: Record<string, unknown>): FormSchema {
    const hooks = _formAlters[formId];
    if (!hooks || hooks.length === 0) return schema;
    return applyFormAlterHooks(hooks, schema, ctx ?? {});
  },
};

/**
 * Install `window.__zveltio` for IIFE bundles. Idempotent — safe to call
 * multiple times (e.g. after HMR reloads the layout). Must run before
 * bundles are loaded.
 */
export function installGlobalApi(engineUrl: string): void {
  if (typeof window === 'undefined') return;
  const existing = (window as any).__zveltio;
  if (existing && existing.__zveltioInstalled) return;
  (window as any).__zveltio = {
    __zveltioInstalled: true,
    engineUrl,
    registerRoute(route: StudioRoute) {
      // Prepend so extensions registered earlier (alphabetical bundle load)
      // appear in their declaration order. Duplicate `path` wins last —
      // matches Drupal hook order semantics.
      const idx = _routes.findIndex((r) => r.path === route.path);
      if (idx >= 0) _routes[idx] = route;
      else _routes.push(route);
    },
    registerSlot(name: string, contribution: SlotContribution) {
      if (!name || typeof name !== 'string') {
        console.warn('[studio-api] registerSlot: name must be a non-empty string');
        return;
      }
      if (!contribution || !contribution.component) {
        console.warn(`[studio-api] registerSlot("${name}"): contribution.component is required`);
        return;
      }
      if (!_slots[name]) _slots[name] = [];
      _slots[name].push(contribution);
    },
    registerFormAlter(formId: string, hook: FormAlterHook) {
      if (!formId || typeof formId !== 'string') {
        console.warn('[studio-api] registerFormAlter: formId must be a non-empty string');
        return;
      }
      if (typeof hook !== 'function') {
        console.warn(`[studio-api] registerFormAlter("${formId}"): hook must be a function`);
        return;
      }
      if (!_formAlters[formId]) _formAlters[formId] = [];
      _formAlters[formId].push(hook);
    },
    // Existing surfaces — keep stable for already-published bundles.
    registerFieldType(_ft: any) {
      /* wired by FieldRegistry; left as-is */
    },
    registerAssetPreview(_h: any) {
      /* wired by AssetPreview; left as-is */
    },
  };
}

/** Test-only: wipe every registry. Used between unit tests. */
export function _resetForTests(): void {
  _routes.length = 0;
  for (const k of Object.keys(_slots)) delete _slots[k];
  for (const k of Object.keys(_formAlters)) delete _formAlters[k];
  if (typeof window !== 'undefined') delete (window as any).__zveltio;
}

// Re-export the proxy maker so tests can exercise it without the full
// register pipeline.
export { makeFormProxy };
